use serde_json::{json, Value};
use tauri::State;

use crate::persistence::with_store;
use crate::AppState;

pub(super) fn payload_knowledge_references(payload: &Value) -> Vec<Value> {
    payload
        .get("knowledgeReferences")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let object = item.as_object()?;
                    let id = object
                        .get("id")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|value| !value.is_empty())?;
                    let mut reference = serde_json::Map::new();
                    reference.insert("type".to_string(), json!("knowledge"));
                    reference.insert("knowledgeId".to_string(), json!(id));
                    for field in [
                        "title",
                        "sourceKind",
                        "summary",
                        "cover",
                        "sourceUrl",
                        "folderPath",
                        "rootPath",
                        "updatedAt",
                    ] {
                        if let Some(value) = object.get(field).and_then(Value::as_str) {
                            let trimmed = value.trim();
                            if !trimmed.is_empty() {
                                reference.insert(field.to_string(), json!(trimmed));
                            }
                        }
                    }
                    if let Some(tags) = object.get("tags").and_then(Value::as_array) {
                        let normalized_tags = tags
                            .iter()
                            .filter_map(Value::as_str)
                            .map(str::trim)
                            .filter(|value| !value.is_empty())
                            .map(|value| json!(value))
                            .collect::<Vec<_>>();
                        if !normalized_tags.is_empty() {
                            reference.insert("tags".to_string(), Value::Array(normalized_tags));
                        }
                    }
                    if let Some(value) = object.get("fileCount").and_then(Value::as_i64) {
                        reference.insert("fileCount".to_string(), json!(value));
                    }
                    if let Some(value) = object.get("hasTranscript").and_then(Value::as_bool) {
                        reference.insert("hasTranscript".to_string(), json!(value));
                    }
                    Some(Value::Object(reference))
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

pub(super) fn payload_asset_references(payload: &Value) -> Vec<Value> {
    payload
        .get("assetReferences")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let object = item.as_object()?;
                    let id = object
                        .get("id")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|value| !value.is_empty())?;
                    let mut reference = serde_json::Map::new();
                    reference.insert("type".to_string(), json!("asset"));
                    reference.insert("assetId".to_string(), json!(id));
                    if let Some(value) = object.get("name").and_then(Value::as_str) {
                        let trimmed = value.trim();
                        if !trimmed.is_empty() {
                            reference.insert("name".to_string(), json!(trimmed));
                        }
                    }
                    Some(Value::Object(reference))
                })
                .collect()
        })
        .unwrap_or_default()
}

pub(super) fn merge_inline_asset_mentions(
    state: &State<'_, AppState>,
    message: &str,
    display_content: &str,
    existing: &[Value],
) -> Result<Vec<Value>, String> {
    with_store(state, |store| {
        Ok(merge_inline_asset_mentions_from_store(
            &store,
            message,
            display_content,
            existing,
        ))
    })
}

pub(super) fn merge_inline_asset_mentions_from_store(
    store: &crate::AppStore,
    message: &str,
    display_content: &str,
    existing: &[Value],
) -> Vec<Value> {
    let mut references = existing.to_vec();
    let mention_names = extract_inline_asset_mention_names(message)
        .into_iter()
        .chain(extract_inline_asset_mention_names(display_content))
        .collect::<Vec<_>>();
    if mention_names.is_empty() {
        return references;
    }
    for mention_name in mention_names {
        let mention_key = normalized_lookup_key(&mention_name);
        if references.iter().any(|item| {
            item.get("name")
                .and_then(Value::as_str)
                .map(normalized_lookup_key)
                .is_some_and(|name| name == mention_key)
        }) {
            continue;
        }
        let matches = store
            .subjects
            .iter()
            .filter(|subject| normalized_lookup_key(&subject.name) == mention_key)
            .collect::<Vec<_>>();
        if matches.len() != 1 {
            continue;
        }
        let subject = matches[0];
        if references.iter().any(|item| {
            item.get("assetId")
                .or_else(|| item.get("id"))
                .and_then(Value::as_str)
                .is_some_and(|id| id == subject.id)
        }) {
            continue;
        }
        references.push(json!({
            "type": "asset",
            "assetId": subject.id,
            "name": subject.name,
        }));
    }
    references
}

pub(super) fn extract_inline_asset_mention_names(text: &str) -> Vec<String> {
    let mut names = Vec::<String>::new();
    let mut chars = text.char_indices().peekable();
    while let Some((_, ch)) = chars.next() {
        if ch != '@' {
            continue;
        }
        let mut name = String::new();
        while let Some((_, next)) = chars.peek().copied() {
            if next.is_whitespace()
                || matches!(
                    next,
                    '@' | '#'
                        | ','
                        | '，'
                        | '.'
                        | '。'
                        | '!'
                        | '！'
                        | '?'
                        | '？'
                        | ':'
                        | '：'
                        | ';'
                        | '；'
                        | '('
                        | ')'
                        | '（'
                        | '）'
                        | '['
                        | ']'
                        | '【'
                        | '】'
                        | '<'
                        | '>'
                        | '《'
                        | '》'
                        | '"'
                        | '\''
                )
            {
                break;
            }
            name.push(next);
            chars.next();
            if name.chars().count() >= 64 {
                break;
            }
        }
        let name = name.trim();
        if !name.is_empty()
            && !names
                .iter()
                .any(|item| normalized_lookup_key(item) == normalized_lookup_key(name))
        {
            names.push(name.to_string());
        }
    }
    names
}

pub(super) fn infer_media_task_intent(message: &str, display_content: &str) -> Option<String> {
    let combined = format!("{message}\n{display_content}").to_lowercase();
    if combined.contains("视频") || combined.contains("video") || combined.contains("mp4") {
        return Some("video".to_string());
    }
    if combined.contains("图片")
        || combined.contains("图像")
        || combined.contains("封面")
        || combined.contains("配图")
        || combined.contains("image")
    {
        return Some("image".to_string());
    }
    if combined.contains("语音")
        || combined.contains("声音")
        || combined.contains("音频")
        || combined.contains("tts")
        || combined.contains("voice")
        || combined.contains("audio")
    {
        return Some("voice".to_string());
    }
    None
}

pub(super) fn chat_user_message_metadata(
    advisor_id: Option<&str>,
    knowledge_references: &[Value],
    asset_references: &[Value],
    task_intent: Option<&str>,
) -> Option<Value> {
    let mut references = Vec::<Value>::new();
    if let Some(member_id) = advisor_id.map(str::trim).filter(|value| !value.is_empty()) {
        references.push(json!({
            "type": "member",
            "memberId": member_id,
            "routeMode": "respond",
        }));
    }
    references.extend(knowledge_references.iter().cloned());
    references.extend(asset_references.iter().cloned());
    if references.is_empty() {
        if let Some(task_intent) = task_intent.map(str::trim).filter(|value| !value.is_empty()) {
            return Some(json!({ "taskIntent": task_intent }));
        }
        return None;
    }
    let mut metadata = json!({
        "references": references,
        "explicitKnowledgeRefs": knowledge_references,
        "explicitAssetRefs": asset_references,
    });
    if let Some(task_intent) = task_intent.map(str::trim).filter(|value| !value.is_empty()) {
        metadata["taskIntent"] = json!(task_intent);
    }
    Some(metadata)
}

fn normalized_lookup_key(value: &str) -> String {
    value.trim().to_lowercase()
}
