use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;
use tauri::State;

use crate::{
    apply_structured_memory_maintenance, build_structured_memory_summary_markdown,
    normalized_memory_type,
};
use crate::{
    generate_structured_response_with_settings, load_redbox_prompt, make_id, normalize_base_url,
    now_i64, now_iso, parse_json_value_from_text, payload_string, render_redbox_prompt,
    run_curl_json, run_curl_text, truncate_chars, value_to_i64_string, with_store, with_store_mut,
    workspace_root, write_json_value, AppState, AppStore, MemoryHistoryRecord, UserMemoryRecord,
};

pub(crate) fn memory_root(state: &State<'_, AppState>) -> Result<PathBuf, String> {
    let root = workspace_root(state)?.join("memory");
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    Ok(root)
}

fn memory_catalog_path(state: &State<'_, AppState>) -> Result<PathBuf, String> {
    Ok(memory_root(state)?.join("catalog.json"))
}

fn memory_history_path(state: &State<'_, AppState>) -> Result<PathBuf, String> {
    Ok(memory_root(state)?.join("history.json"))
}

fn memory_maintenance_status_path(state: &State<'_, AppState>) -> Result<PathBuf, String> {
    Ok(memory_root(state)?.join("maintenance-status.json"))
}

fn memory_summary_markdown(memories: &[UserMemoryRecord]) -> String {
    build_structured_memory_summary_markdown(memories)
}

pub(crate) fn persist_memory_workspace_state(
    state: &State<'_, AppState>,
    store: &AppStore,
) -> Result<(), String> {
    write_json_value(
        &memory_catalog_path(state)?,
        &json!({ "memories": store.memories }),
    )?;
    write_json_value(
        &memory_history_path(state)?,
        &json!({ "items": store.memory_history }),
    )?;
    fs::write(
        memory_root(state)?.join("MEMORY.md"),
        memory_summary_markdown(&store.memories),
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

pub(crate) fn memory_maintenance_status_from_workspace(
    state: &State<'_, AppState>,
) -> Result<Option<Value>, String> {
    let path = memory_maintenance_status_path(state)?;
    Ok(fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .filter(|value| value.is_object()))
}

pub(crate) fn write_memory_maintenance_status_for_workspace(
    state: &State<'_, AppState>,
    status: &Value,
) -> Result<(), String> {
    write_json_value(&memory_maintenance_status_path(state)?, status)
}

pub(crate) fn build_memory_maintenance_prompt(store: &AppStore) -> String {
    let template =
        load_redbox_prompt("runtime/memory/maintenance_manager.txt").unwrap_or_else(|| {
            "You are a memory maintenance manager. Output strict JSON only.".to_string()
        });
    let active_memories: Vec<Value> = store
        .memories
        .iter()
        .filter(|item| item.status.as_deref().unwrap_or("active") == "active")
        .cloned()
        .map(|item| {
            json!({
                "id": item.id,
                "type": normalized_memory_type(&item),
                "content": item.content,
                "summary": item.summary,
                "tags": item.tags,
                "sourceSessionId": item.source_session_id,
                "sourceCheckpointId": item.source_checkpoint_id,
                "sourceToolResultId": item.source_tool_result_id,
                "scopeKey": item.scope_key,
                "confidence": item.confidence,
                "expiresAt": item.expires_at,
                "updatedAt": item.updated_at,
            })
        })
        .collect();
    let archived_memories: Vec<Value> = store
        .memories
        .iter()
        .filter(|item| item.status.as_deref() == Some("archived"))
        .cloned()
        .map(|item| json!(item))
        .collect();
    let history: Vec<Value> = store
        .memory_history
        .iter()
        .cloned()
        .map(|item| json!(item))
        .collect();
    let recent_conversations: Vec<Value> = store
        .chat_sessions
        .iter()
        .take(5)
        .map(|session| {
            let metadata = session.metadata.clone().unwrap_or_else(|| json!({}));
            let messages = store
                .chat_messages
                .iter()
                .filter(|item| item.session_id == session.id)
                .take(12)
                .map(|item| {
                    json!({
                        "role": item.role,
                        "content": truncate_chars(&item.content, 280),
                        "timestamp": item.created_at,
                    })
                })
                .collect::<Vec<_>>();
            json!({
                "sessionId": session.id,
                "title": session.title,
                "updatedAt": session.updated_at,
                "contextType": metadata.get("contextType").cloned().unwrap_or_else(|| json!("unknown")),
                "messageCount": messages.len(),
                "messages": messages,
            })
        })
        .collect();
    render_redbox_prompt(
        &template,
        &[
            ("trigger_reason", "manual".to_string()),
            ("current_date", now_iso()),
            ("pending_mutation_count", "0".to_string()),
            ("active_memory_count", active_memories.len().to_string()),
            ("archived_memory_count", archived_memories.len().to_string()),
            ("history_count", history.len().to_string()),
            (
                "recent_conversations_count",
                recent_conversations.len().to_string(),
            ),
            (
                "active_memories_json",
                serde_json::to_string_pretty(&active_memories).unwrap_or_else(|_| "[]".to_string()),
            ),
            (
                "archived_memories_json",
                serde_json::to_string_pretty(&archived_memories)
                    .unwrap_or_else(|_| "[]".to_string()),
            ),
            (
                "history_json",
                serde_json::to_string_pretty(&history).unwrap_or_else(|_| "[]".to_string()),
            ),
            (
                "recent_conversations_json",
                serde_json::to_string_pretty(&recent_conversations)
                    .unwrap_or_else(|_| "[]".to_string()),
            ),
        ],
    )
}

pub(crate) fn bump_memory_maintenance_mutation(
    state: &State<'_, AppState>,
    store: &mut AppStore,
    reason: &str,
) {
    let current = memory_maintenance_status_from_workspace(state)
        .ok()
        .flatten()
        .or_else(|| memory_maintenance_status_from_settings(&store.settings))
        .unwrap_or_else(default_memory_maintenance_status);
    let pending = current
        .get("pendingMutations")
        .and_then(|value| value.as_i64())
        .unwrap_or(0)
        + 1;
    let next_delay_ms = if pending >= 5 {
        15 * 60 * 1000
    } else {
        90 * 60 * 1000
    };
    let status = json!({
        "started": true,
        "running": false,
        "lockState": current.get("lockState").cloned().unwrap_or_else(|| json!("owner")),
        "blockedBy": current.get("blockedBy").cloned().unwrap_or(Value::Null),
        "pendingMutations": pending,
        "lastRunAt": current.get("lastRunAt").cloned().unwrap_or(Value::Null),
        "lastScanAt": current.get("lastScanAt").cloned().unwrap_or(Value::Null),
        "lastReason": reason,
        "lastSummary": current.get("lastSummary").cloned().unwrap_or_else(|| json!("RedBox memory maintenance has not run yet.")),
        "lastError": current.get("lastError").cloned().unwrap_or(Value::Null),
        "nextScheduledAt": now_i64() + next_delay_ms,
    });
    let _ = write_memory_maintenance_status_for_workspace(state, &status);
    if let Some(object) = store.settings.as_object_mut() {
        object.remove("redbox_memory_maintenance_status_json");
    }
    store.redclaw_state.next_maintenance_at = value_to_i64_string(status.get("nextScheduledAt"));
}

pub(crate) fn run_memory_maintenance_with_reason(
    state: &State<'_, AppState>,
    reason: &str,
) -> Result<Value, String> {
    let pre_summary = with_store_mut(state, |store| {
        let summary = apply_structured_memory_maintenance(store);
        persist_memory_workspace_state(state, store)?;
        Ok(summary)
    })?;
    let settings_snapshot = with_store(state, |store| Ok(store.settings.clone()))?;
    let prompt = with_store(state, |store| Ok(build_memory_maintenance_prompt(&store)))?;
    let system_prompt =
        "You are the background long-term memory maintenance manager for RedBox. Output strict JSON only.";
    let raw = generate_structured_response_with_settings(
        &settings_snapshot,
        None,
        system_prompt,
        &prompt,
        true,
    )?;
    let parsed = parse_json_value_from_text(&raw).unwrap_or_else(|| {
        json!({
            "summary": "memory-maintenance:no-parse",
            "actions": [{ "type": "noop", "reason": "parse-failed" }]
        })
    });
    let actions = parsed
        .get("actions")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();
    let mut applied = 0_i64;
    let mut archived = 0_i64;
    let mut deleted = 0_i64;
    with_store_mut(state, |store| {
        for action in actions {
            let action_type = payload_string(&action, "type").unwrap_or_default();
            match action_type.as_str() {
                "create" => {
                    let content = payload_string(&action, "content").unwrap_or_default();
                    if content.trim().is_empty() {
                        continue;
                    }
                    let memory_type = crate::normalize_memory_type(
                        payload_string(&action, "memoryType").as_deref(),
                    );
                    let tags = action
                        .get("tags")
                        .and_then(|value| value.as_array())
                        .map(|items| {
                            items
                                .iter()
                                .filter_map(|item| item.as_str().map(ToString::to_string))
                                .collect::<Vec<_>>()
                        })
                        .unwrap_or_default();
                    let record = UserMemoryRecord {
                        id: make_id("memory"),
                        content,
                        r#type: memory_type,
                        tags,
                        created_at: now_i64(),
                        updated_at: Some(now_i64()),
                        last_accessed: None,
                        status: Some("active".to_string()),
                        archived_at: None,
                        archive_reason: None,
                        origin_id: None,
                        canonical_key: None,
                        revision: Some(1),
                        last_conflict_at: None,
                        summary: payload_string(&action, "summary"),
                        scope_key: payload_string(&action, "scopeKey"),
                        source_session_id: payload_string(&action, "sourceSessionId"),
                        source_checkpoint_id: payload_string(&action, "sourceCheckpointId"),
                        source_tool_result_id: payload_string(&action, "sourceToolResultId"),
                        confidence: action.get("confidence").and_then(|value| value.as_f64()),
                        expires_at: action.get("expiresAt").and_then(|value| value.as_i64()),
                        last_maintained_at: Some(now_i64()),
                    };
                    store.memories.push(record.clone());
                    store.memory_history.push(MemoryHistoryRecord {
                        id: make_id("memory-history"),
                        memory_id: record.id.clone(),
                        origin_id: record.id.clone(),
                        action: "create".to_string(),
                        reason: payload_string(&action, "reason"),
                        timestamp: now_i64(),
                        before: None,
                        after: Some(json!(record)),
                        archived_memory_id: None,
                    });
                    applied += 1;
                }
                "update" => {
                    let target_id = payload_string(&action, "targetMemoryId").unwrap_or_default();
                    let content = payload_string(&action, "content").unwrap_or_default();
                    if let Some(item) = store
                        .memories
                        .iter_mut()
                        .find(|entry| entry.id == target_id)
                    {
                        let before = json!(item.clone());
                        if !content.trim().is_empty() {
                            item.content = content;
                        }
                        if let Some(memory_type) = payload_string(&action, "memoryType") {
                            item.r#type = crate::normalize_memory_type(Some(&memory_type));
                        }
                        if let Some(tags) = action.get("tags").and_then(|value| value.as_array()) {
                            item.tags = tags
                                .iter()
                                .filter_map(|entry| entry.as_str().map(ToString::to_string))
                                .collect();
                        }
                        if let Some(summary) = payload_string(&action, "summary") {
                            item.summary = Some(summary);
                        }
                        if let Some(scope_key) = payload_string(&action, "scopeKey") {
                            item.scope_key = Some(scope_key);
                        }
                        item.last_maintained_at = Some(now_i64());
                        item.updated_at = Some(now_i64());
                        let after = json!(item.clone());
                        store.memory_history.push(MemoryHistoryRecord {
                            id: make_id("memory-history"),
                            memory_id: item.id.clone(),
                            origin_id: item.origin_id.clone().unwrap_or_else(|| item.id.clone()),
                            action: "update".to_string(),
                            reason: payload_string(&action, "reason"),
                            timestamp: now_i64(),
                            before: Some(before),
                            after: Some(after),
                            archived_memory_id: None,
                        });
                        applied += 1;
                    }
                }
                "archive" => {
                    let target_id = payload_string(&action, "targetMemoryId").unwrap_or_default();
                    if let Some(item) = store
                        .memories
                        .iter_mut()
                        .find(|entry| entry.id == target_id)
                    {
                        let before = json!(item.clone());
                        item.status = Some("archived".to_string());
                        item.archived_at = Some(now_i64());
                        item.archive_reason = payload_string(&action, "reason");
                        let after = json!(item.clone());
                        store.memory_history.push(MemoryHistoryRecord {
                            id: make_id("memory-history"),
                            memory_id: item.id.clone(),
                            origin_id: item.origin_id.clone().unwrap_or_else(|| item.id.clone()),
                            action: "archive".to_string(),
                            reason: payload_string(&action, "reason"),
                            timestamp: now_i64(),
                            before: Some(before),
                            after: Some(after),
                            archived_memory_id: Some(item.id.clone()),
                        });
                        archived += 1;
                    }
                }
                "delete" => {
                    let target_id = payload_string(&action, "targetMemoryId").unwrap_or_default();
                    if let Some(index) = store
                        .memories
                        .iter()
                        .position(|entry| entry.id == target_id)
                    {
                        let before = json!(store.memories[index].clone());
                        let removed = store.memories.remove(index);
                        store.memory_history.push(MemoryHistoryRecord {
                            id: make_id("memory-history"),
                            memory_id: target_id.clone(),
                            origin_id: removed
                                .origin_id
                                .clone()
                                .unwrap_or_else(|| removed.id.clone()),
                            action: "delete".to_string(),
                            reason: payload_string(&action, "reason"),
                            timestamp: now_i64(),
                            before: Some(before),
                            after: None,
                            archived_memory_id: None,
                        });
                        deleted += 1;
                    }
                }
                _ => {}
            }
        }
        Ok(())
    })?;
    let post_summary = with_store_mut(state, |store| {
        let summary = apply_structured_memory_maintenance(store);
        persist_memory_workspace_state(state, store)?;
        Ok(summary)
    })?;
    let next_scheduled = match reason {
        "query-after" => now_i64() + 5 * 60 * 1000,
        "periodic" => now_i64() + 30 * 60 * 1000,
        _ => now_i64() + 20 * 60 * 1000,
    };
    let status = json!({
        "started": true,
        "running": false,
        "lockState": "owner",
        "blockedBy": Value::Null,
        "pendingMutations": 0,
        "lastRunAt": now_i64(),
        "lastScanAt": now_i64(),
        "lastReason": reason,
        "lastSummary": parsed.get("summary").and_then(|value| value.as_str()).map(ToString::to_string).unwrap_or_else(|| {
            format!(
                "RedBox memory maintenance completed. normalized={} deduped={} compressed={} archivedTaskLearnings={}",
                pre_summary.normalized + post_summary.normalized,
                pre_summary.deduped + post_summary.deduped,
                pre_summary.compressed + post_summary.compressed,
                pre_summary.archived_task_learnings + post_summary.archived_task_learnings
            )
        }),
        "lastError": Value::Null,
        "nextScheduledAt": next_scheduled,
        "raw": parsed,
        "applied": applied,
        "archived": archived,
        "deleted": deleted
    });
    let _ = with_store_mut(state, |store| {
        let _ = write_memory_maintenance_status_for_workspace(state, &status);
        if let Some(object) = store.settings.as_object_mut() {
            object.remove("redbox_memory_maintenance_status_json");
        }
        store.redclaw_state.next_maintenance_at =
            value_to_i64_string(status.get("nextScheduledAt"));
        persist_memory_workspace_state(state, store)?;
        Ok(())
    });
    Ok(status)
}

pub(crate) fn url_encode_component(value: &str) -> String {
    let mut out = String::new();
    for byte in value.as_bytes() {
        match *byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char)
            }
            b' ' => out.push_str("%20"),
            other => out.push_str(&format!("%{:02X}", other)),
        }
    }
    out
}

pub(crate) fn normalize_search_provider(value: Option<&str>) -> &'static str {
    match value.unwrap_or("duckduckgo").trim().to_lowercase().as_str() {
        "tavily" => "tavily",
        "searxng" => "searxng",
        _ => "duckduckgo",
    }
}

pub(crate) fn parse_duckduckgo_results(html: &str, count: usize) -> Vec<Value> {
    let mut results = Vec::new();
    let mut rest = html;
    while results.len() < count {
        let Some(anchor_idx) = rest.find("result__a") else {
            break;
        };
        let anchor_slice = &rest[anchor_idx..];
        let Some(href_idx) = anchor_slice.find("href=\"") else {
            rest = &anchor_slice["result__a".len()..];
            continue;
        };
        let href_slice = &anchor_slice[href_idx + 6..];
        let Some(href_end) = href_slice.find('"') else {
            break;
        };
        let url = href_slice[..href_end].trim().to_string();
        let Some(tag_close) = href_slice[href_end..].find('>') else {
            break;
        };
        let title_slice = &href_slice[href_end + tag_close + 1..];
        let Some(title_end) = title_slice.find("</a>") else {
            break;
        };
        let title = title_slice[..title_end]
            .replace("<b>", "")
            .replace("</b>", "")
            .replace("&amp;", "&")
            .replace("&#x27;", "'")
            .trim()
            .to_string();
        let snippet = if let Some(snippet_idx) = title_slice.find("result__snippet") {
            let snippet_slice = &title_slice[snippet_idx..];
            if let Some(start) = snippet_slice.find('>') {
                if let Some(end) = snippet_slice[start + 1..].find("</a>") {
                    snippet_slice[start + 1..start + 1 + end]
                        .replace("<b>", "")
                        .replace("</b>", "")
                        .replace("&amp;", "&")
                        .replace("&#x27;", "'")
                        .replace('\n', " ")
                        .trim()
                        .to_string()
                } else {
                    String::new()
                }
            } else {
                String::new()
            }
        } else {
            String::new()
        };
        if !title.is_empty() && !url.is_empty() && !url.contains("duckduckgo.com") {
            results.push(json!({
                "title": title,
                "url": url,
                "snippet": snippet,
            }));
        }
        rest = &title_slice[title_end..];
    }
    results
}

pub(crate) fn search_web_with_settings(
    settings: &Value,
    query: &str,
    count: usize,
) -> Result<Vec<Value>, String> {
    let provider =
        normalize_search_provider(payload_string(settings, "search_provider").as_deref());
    let endpoint = payload_string(settings, "search_endpoint").unwrap_or_default();
    let api_key = payload_string(settings, "search_api_key").unwrap_or_default();
    match provider {
        "tavily" => {
            if api_key.trim().is_empty() {
                return Err("Tavily 搜索需要先配置 API Key".to_string());
            }
            let base = if endpoint.trim().is_empty() {
                "https://api.tavily.com".to_string()
            } else {
                normalize_base_url(&endpoint)
            };
            let response = run_curl_json(
                "POST",
                &format!("{}/search", base),
                None,
                &[("Content-Type", "application/json".to_string())],
                Some(json!({
                    "api_key": api_key,
                    "query": query,
                    "max_results": count,
                    "search_depth": "basic",
                    "include_answer": false,
                    "include_images": false
                })),
            )?;
            Ok(response
                .get("results")
                .and_then(|value| value.as_array())
                .cloned()
                .unwrap_or_default())
        }
        "searxng" => {
            let base = normalize_base_url(&endpoint);
            if base.is_empty() {
                return Err("SearXNG 搜索需要先配置 endpoint".to_string());
            }
            let url = format!(
                "{}/search?q={}&format=json&language=zh-CN",
                base,
                url_encode_component(query)
            );
            let mut headers = Vec::new();
            if !api_key.trim().is_empty() {
                headers.push(("Authorization", format!("Bearer {}", api_key.trim())));
            }
            let response = run_curl_json("GET", &url, None, &headers, None)?;
            Ok(response
                .get("results")
                .and_then(|value| value.as_array())
                .cloned()
                .unwrap_or_default())
        }
        _ => {
            let url = format!(
                "https://html.duckduckgo.com/html/?q={}",
                url_encode_component(query)
            );
            let html = run_curl_text(
                "GET",
                &url,
                &[(
                    "User-Agent",
                    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36".to_string(),
                )],
                None,
            )?;
            Ok(parse_duckduckgo_results(&html, count))
        }
    }
}

pub(crate) fn memory_maintenance_status_from_settings(settings: &Value) -> Option<Value> {
    payload_string(settings, "redbox_memory_maintenance_status_json")
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .filter(|value| value.is_object())
}

pub(crate) fn default_memory_maintenance_status() -> Value {
    json!({
        "started": true,
        "running": false,
        "lockState": "owner",
        "blockedBy": Value::Null,
        "pendingMutations": 0,
        "lastRunAt": Value::Null,
        "lastScanAt": Value::Null,
        "lastReason": Value::Null,
        "lastSummary": "RedBox memory maintenance has not run yet.",
        "lastError": Value::Null,
        "nextScheduledAt": Value::Null,
    })
}
