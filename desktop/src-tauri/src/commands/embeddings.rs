use serde_json::{Value, json};
use tauri::{AppHandle, State};

use crate::persistence::{with_store, with_store_mut};
use crate::{
    AppState, EmbeddingCacheRecord, SimilarityCacheRecord, compute_embedding_with_settings,
    cosine_similarity, default_indexing_stats, knowledge_source_texts, knowledge_version, now_iso,
    payload_field, payload_string, payload_value_as_string,
};

pub fn handle_embeddings_channel(
    _app: &AppHandle,
    state: &State<'_, AppState>,
    channel: &str,
    payload: &Value,
) -> Option<Result<Value, String>> {
    if !matches!(
        channel,
        "indexing:get-stats"
            | "indexing:clear-queue"
            | "indexing:remove-item"
            | "indexing:rebuild-all"
            | "indexing:rebuild-advisor"
            | "embedding:compute"
            | "embedding:get-manuscript-cache"
            | "embedding:save-manuscript-cache"
            | "embedding:get-sorted-sources"
            | "similarity:get-knowledge-version"
            | "similarity:get-cache"
            | "similarity:save-cache"
    ) {
        return None;
    }

    Some((|| -> Result<Value, String> {
        match channel {
            "indexing:get-stats" => Ok(default_indexing_stats()),
            "indexing:clear-queue"
            | "indexing:remove-item"
            | "indexing:rebuild-all"
            | "indexing:rebuild-advisor" => Ok(json!({ "success": true })),
            "embedding:compute" => {
                let text = payload_value_as_string(payload)
                    .or_else(|| payload_string(payload, "text"))
                    .unwrap_or_default();
                let settings_snapshot = with_store(state, |store| Ok(store.settings.clone()))?;
                let embedding = compute_embedding_with_settings(&settings_snapshot, &text);
                Ok(json!({ "success": true, "embedding": embedding }))
            }
            "embedding:get-manuscript-cache" => {
                let file_path = payload_value_as_string(payload)
                    .or_else(|| payload_string(payload, "filePath"))
                    .unwrap_or_default();
                with_store(state, |store| {
                    let cached = store
                        .embedding_cache
                        .iter()
                        .find(|item| item.file_path == file_path)
                        .cloned();
                    Ok(json!({ "success": true, "cached": cached }))
                })
            }
            "embedding:save-manuscript-cache" => {
                let file_path = payload_string(payload, "filePath").unwrap_or_default();
                let content_hash = payload_string(payload, "contentHash").unwrap_or_default();
                let embedding = payload_field(payload, "embedding")
                    .and_then(|item| item.as_array())
                    .map(|items| {
                        items
                            .iter()
                            .filter_map(|item| item.as_f64())
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default();
                with_store_mut(state, |store| {
                    if let Some(existing) = store
                        .embedding_cache
                        .iter_mut()
                        .find(|item| item.file_path == file_path)
                    {
                        existing.content_hash = content_hash.clone();
                        existing.embedding = embedding.clone();
                        existing.updated_at = now_iso();
                    } else {
                        store.embedding_cache.push(EmbeddingCacheRecord {
                            file_path,
                            content_hash,
                            embedding,
                            updated_at: now_iso(),
                        });
                    }
                    Ok(json!({ "success": true }))
                })
            }
            "embedding:get-sorted-sources" => {
                let input_embedding = payload
                    .as_array()
                    .map(|items| {
                        items
                            .iter()
                            .filter_map(|item| item.as_f64())
                            .collect::<Vec<_>>()
                    })
                    .or_else(|| {
                        payload_field(payload, "embedding").and_then(|item| {
                            item.as_array().map(|items| {
                                items
                                    .iter()
                                    .filter_map(|value| value.as_f64())
                                    .collect::<Vec<_>>()
                            })
                        })
                    })
                    .unwrap_or_default();
                let settings_snapshot = with_store(state, |store| Ok(store.settings.clone()))?;
                with_store(state, |store| {
                    let mut sorted = knowledge_source_texts(&store)
                        .into_iter()
                        .map(|(source_id, text, meta)| {
                            let embedding =
                                compute_embedding_with_settings(&settings_snapshot, &text);
                            let score = cosine_similarity(&input_embedding, &embedding);
                            json!({ "sourceId": source_id, "score": score, "meta": meta })
                        })
                        .collect::<Vec<_>>();
                    sorted.sort_by(|a, b| {
                        let left = a.get("score").and_then(|item| item.as_f64()).unwrap_or(0.0);
                        let right = b.get("score").and_then(|item| item.as_f64()).unwrap_or(0.0);
                        right
                            .partial_cmp(&left)
                            .unwrap_or(std::cmp::Ordering::Equal)
                    });
                    Ok(json!({ "success": true, "sorted": sorted }))
                })
            }
            "similarity:get-knowledge-version" => {
                with_store(state, |store| Ok(json!(knowledge_version(&store))))
            }
            "similarity:get-cache" => {
                let manuscript_id = payload_value_as_string(payload)
                    .or_else(|| payload_string(payload, "manuscriptId"))
                    .unwrap_or_default();
                with_store(state, |store| {
                    let cache = store
                        .similarity_cache
                        .iter()
                        .find(|item| item.manuscript_id == manuscript_id)
                        .cloned();
                    Ok(json!({
                        "success": true,
                        "cache": cache,
                        "currentKnowledgeVersion": knowledge_version(&store)
                    }))
                })
            }
            "similarity:save-cache" => {
                let manuscript_id = payload_string(payload, "manuscriptId").unwrap_or_default();
                let content_hash = payload_string(payload, "contentHash").unwrap_or_default();
                let knowledge_version_value =
                    payload_string(payload, "knowledgeVersion").unwrap_or_default();
                let sorted_ids = payload_field(payload, "sortedIds")
                    .and_then(|item| item.as_array())
                    .map(|items| {
                        items
                            .iter()
                            .filter_map(|item| item.as_str().map(ToString::to_string))
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default();
                with_store_mut(state, |store| {
                    if let Some(existing) = store
                        .similarity_cache
                        .iter_mut()
                        .find(|item| item.manuscript_id == manuscript_id)
                    {
                        existing.content_hash = content_hash.clone();
                        existing.knowledge_version = knowledge_version_value.clone();
                        existing.sorted_ids = sorted_ids.clone();
                        existing.updated_at = now_iso();
                    } else {
                        store.similarity_cache.push(SimilarityCacheRecord {
                            manuscript_id,
                            content_hash,
                            knowledge_version: knowledge_version_value,
                            sorted_ids,
                            updated_at: now_iso(),
                        });
                    }
                    Ok(json!({ "success": true }))
                })
            }
            _ => unreachable!(),
        }
    })())
}
