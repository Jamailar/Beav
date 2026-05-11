use crate::knowledge;
use crate::persistence::{ensure_store_hydrated_for_work, with_store, with_store_mut};
use crate::*;
use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, State};

pub fn handle_workspace_data_channel(
    app: &AppHandle,
    state: &State<'_, AppState>,
    channel: &str,
    payload: &Value,
) -> Option<Result<Value, String>> {
    if let Some(result) = crate::memory::handle_memory_channel(state, channel, payload) {
        return Some(result);
    }

    if !matches!(
        channel,
        "youtube:save-note"
            | "work:list"
            | "work:ready"
            | "work:get"
            | "work:update"
            | "archives:list"
            | "archives:create"
            | "archives:update"
            | "archives:delete"
            | "archives:samples:list"
            | "archives:samples:create"
            | "archives:samples:update"
            | "archives:samples:delete"
    ) {
        return None;
    }

    Some((|| -> Result<Value, String> {
        match channel {
            "youtube:save-note" => {
                let input: YoutubeSavePayload = serde_json::from_value(payload.clone())
                    .map_err(|error| format!("YouTube note payload 无效: {error}"))?;
                knowledge::save_youtube_note(app, state, &input)
            }
            "work:list" => {
                let _ = ensure_store_hydrated_for_work(state);
                with_store(state, |store| {
                    let mut items = store.work_items.clone();
                    items.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
                    Ok(json!(items))
                })
            }
            "work:ready" => with_store(state, |store| {
                let mut items: Vec<WorkItemRecord> = store
                    .work_items
                    .iter()
                    .filter(|item| {
                        item.effective_status == "ready" || item.effective_status == "pending"
                    })
                    .cloned()
                    .collect();
                items.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
                Ok(json!(items))
            }),
            "work:get" => {
                let id = payload_string(payload, "id").unwrap_or_default();
                with_store(state, |store| {
                    Ok(store
                        .work_items
                        .iter()
                        .find(|item| item.id == id)
                        .cloned()
                        .map_or(Value::Null, |item| json!(item)))
                })
            }
            "work:update" => {
                let id = payload_string(payload, "id").unwrap_or_default();
                let status = normalize_optional_string(payload_string(payload, "status"));
                let title = normalize_optional_string(payload_string(payload, "title"));
                let description = normalize_optional_string(payload_string(payload, "description"));
                let summary = normalize_optional_string(payload_string(payload, "summary"));
                with_store_mut(state, |store| {
                    let Some(item) = store.work_items.iter_mut().find(|entry| entry.id == id)
                    else {
                        return Ok(json!({ "success": false, "error": "工作项不存在" }));
                    };
                    if let Some(title) = title {
                        item.title = title;
                    }
                    if let Some(description) = description {
                        item.description = Some(description);
                    }
                    if let Some(summary) = summary {
                        item.summary = Some(summary);
                    }
                    if let Some(status) = status {
                        item.status = status.clone();
                        item.effective_status = match status.as_str() {
                            "pending" => "ready".to_string(),
                            other => other.to_string(),
                        };
                        item.completed_at = if status == "done" {
                            Some(now_iso())
                        } else {
                            None
                        };
                    }
                    item.updated_at = now_iso();
                    Ok(json!({ "success": true, "item": item.clone() }))
                })
            }
            "archives:list" => with_store(state, |store| {
                let mut items = store.archive_profiles.clone();
                items.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
                Ok(json!(items))
            }),
            "archives:create" => {
                let profile = with_store_mut(state, |store| {
                    let item = ArchiveProfileRecord {
                        id: make_id("archive-profile"),
                        name: payload_string(payload, "name")
                            .unwrap_or_else(|| "未命名档案".to_string()),
                        platform: normalize_optional_string(payload_string(payload, "platform")),
                        goal: normalize_optional_string(payload_string(payload, "goal")),
                        domain: normalize_optional_string(payload_string(payload, "domain")),
                        audience: normalize_optional_string(payload_string(payload, "audience")),
                        tone_tags: payload_field(payload, "toneTags")
                            .and_then(|value| value.as_array())
                            .map(|values| {
                                values
                                    .iter()
                                    .filter_map(|item| {
                                        item.as_str().map(|value| value.trim().to_string())
                                    })
                                    .filter(|value| !value.is_empty())
                                    .collect::<Vec<_>>()
                            })
                            .unwrap_or_default(),
                        created_at: now_i64(),
                        updated_at: now_i64(),
                    };
                    store.archive_profiles.push(item.clone());
                    Ok(item)
                })?;
                Ok(json!(profile))
            }
            "archives:update" => {
                let id = payload_string(payload, "id").unwrap_or_default();
                with_store_mut(state, |store| {
                    let Some(item) = store
                        .archive_profiles
                        .iter_mut()
                        .find(|entry| entry.id == id)
                    else {
                        return Ok(json!({ "success": false, "error": "档案不存在" }));
                    };
                    if let Some(name) = normalize_optional_string(payload_string(payload, "name")) {
                        item.name = name;
                    }
                    item.platform = normalize_optional_string(payload_string(payload, "platform"));
                    item.goal = normalize_optional_string(payload_string(payload, "goal"));
                    item.domain = normalize_optional_string(payload_string(payload, "domain"));
                    item.audience = normalize_optional_string(payload_string(payload, "audience"));
                    item.tone_tags = payload_field(payload, "toneTags")
                        .and_then(|value| value.as_array())
                        .map(|values| {
                            values
                                .iter()
                                .filter_map(|entry| {
                                    entry.as_str().map(|value| value.trim().to_string())
                                })
                                .filter(|value| !value.is_empty())
                                .collect::<Vec<_>>()
                        })
                        .unwrap_or_default();
                    item.updated_at = now_i64();
                    Ok(json!({ "success": true, "profile": item.clone() }))
                })
            }
            "archives:delete" => {
                let id = payload_value_as_string(payload).unwrap_or_default();
                with_store_mut(state, |store| {
                    store.archive_profiles.retain(|item| item.id != id);
                    store.archive_samples.retain(|item| item.profile_id != id);
                    Ok(json!({ "success": true }))
                })
            }
            "archives:samples:list" => {
                let profile_id = payload_value_as_string(payload).unwrap_or_default();
                with_store(state, |store| {
                    let mut items: Vec<ArchiveSampleRecord> = store
                        .archive_samples
                        .iter()
                        .filter(|item| item.profile_id == profile_id)
                        .cloned()
                        .collect();
                    items.sort_by(|a, b| b.created_at.cmp(&a.created_at));
                    Ok(json!(items))
                })
            }
            "archives:samples:create" => {
                let sample = with_store_mut(state, |store| {
                    let content = payload_string(payload, "content").unwrap_or_default();
                    let item = ArchiveSampleRecord {
                        id: make_id("archive-sample"),
                        profile_id: payload_string(payload, "profileId").unwrap_or_default(),
                        title: normalize_optional_string(payload_string(payload, "title")),
                        excerpt: normalize_optional_string(Some(
                            content.chars().take(160).collect::<String>(),
                        )),
                        content: Some(content),
                        tags: payload_field(payload, "tags")
                            .and_then(|value| value.as_array())
                            .map(|values| {
                                values
                                    .iter()
                                    .filter_map(|entry| entry.as_str().map(ToString::to_string))
                                    .collect()
                            })
                            .unwrap_or_default(),
                        images: Vec::new(),
                        platform: normalize_optional_string(payload_string(payload, "platform")),
                        source_url: normalize_optional_string(payload_string(payload, "sourceUrl")),
                        sample_date: normalize_optional_string(payload_string(
                            payload,
                            "sampleDate",
                        )),
                        is_featured: if payload_field(payload, "isFeatured")
                            .and_then(|v| v.as_bool())
                            .unwrap_or(false)
                        {
                            1
                        } else {
                            0
                        },
                        created_at: now_i64(),
                    };
                    store.archive_samples.push(item.clone());
                    Ok(item)
                })?;
                let _ = app.emit(
                    "archives:sample-created",
                    json!({ "profileId": sample.profile_id.clone() }),
                );
                Ok(json!(sample))
            }
            "archives:samples:update" => {
                let id = payload_string(payload, "id").unwrap_or_default();
                with_store_mut(state, |store| {
                    let Some(item) = store
                        .archive_samples
                        .iter_mut()
                        .find(|entry| entry.id == id)
                    else {
                        return Ok(json!({ "success": false, "error": "样本不存在" }));
                    };
                    let content = payload_string(payload, "content").unwrap_or_default();
                    item.profile_id = payload_string(payload, "profileId")
                        .unwrap_or_else(|| item.profile_id.clone());
                    item.title = normalize_optional_string(payload_string(payload, "title"));
                    item.content = Some(content.clone());
                    item.excerpt = normalize_optional_string(Some(
                        content.chars().take(160).collect::<String>(),
                    ));
                    item.tags = payload_field(payload, "tags")
                        .and_then(|value| value.as_array())
                        .map(|values| {
                            values
                                .iter()
                                .filter_map(|entry| entry.as_str().map(ToString::to_string))
                                .collect()
                        })
                        .unwrap_or_default();
                    item.platform = normalize_optional_string(payload_string(payload, "platform"));
                    item.sample_date =
                        normalize_optional_string(payload_string(payload, "sampleDate"));
                    item.is_featured = if payload_field(payload, "isFeatured")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false)
                    {
                        1
                    } else {
                        0
                    };
                    Ok(json!({ "success": true, "sample": item.clone() }))
                })
            }
            "archives:samples:delete" => {
                let id = payload_value_as_string(payload).unwrap_or_default();
                with_store_mut(state, |store| {
                    store.archive_samples.retain(|item| item.id != id);
                    Ok(json!({ "success": true }))
                })
            }
            _ => unreachable!(),
        }
    })())
}
