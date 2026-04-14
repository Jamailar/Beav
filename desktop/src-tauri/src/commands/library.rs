use crate::persistence::{
    ensure_store_hydrated_for_cover, ensure_store_hydrated_for_knowledge,
    ensure_store_hydrated_for_media, with_store, with_store_mut,
};
use crate::*;
use serde_json::{json, Value};
use std::fs;
use tauri::{AppHandle, Emitter, State};

fn builtin_animation_elements() -> Vec<Value> {
    vec![json!({
        "id": "builtin:apple-drop",
        "name": "苹果落地",
        "storageKey": "builtin:apple-drop",
        "source": "builtin",
        "componentType": "apple-drop",
        "durationMs": 1000,
        "renderMode": "motion-layer",
        "props": {
            "templateId": "static",
            "overlayTitle": "苹果落地",
            "overlayBody": Value::Null,
            "overlays": []
        },
        "entities": [{
            "id": "apple",
            "type": "shape",
            "shape": "apple",
            "x": 430,
            "y": 220,
            "width": 220,
            "height": 260,
            "fill": "#d91f26",
            "animations": [{
                "id": "apple-fall",
                "kind": "fall-bounce",
                "fromFrame": 0,
                "durationInFrames": 30,
                "params": {
                    "fromY": -420,
                    "floorY": 760,
                    "bounces": 3,
                    "decay": 0.35
                }
            }]
        }]
    })]
}

fn animation_element_public_value(value: &Value) -> Value {
    json!({
        "id": value.get("id").cloned().unwrap_or(Value::Null),
        "name": value.get("name").cloned().unwrap_or_else(|| json!("未命名元素")),
        "storageKey": value.get("storageKey").cloned().unwrap_or_else(|| value.get("id").cloned().unwrap_or(Value::Null)),
        "source": value.get("source").cloned().unwrap_or_else(|| json!("workspace")),
        "componentType": value.get("componentType").cloned().unwrap_or_else(|| json!("scene-sequence")),
        "durationMs": value.get("durationMs").cloned().unwrap_or_else(|| json!(2000)),
        "renderMode": value.get("renderMode").cloned().unwrap_or_else(|| json!("motion-layer")),
        "props": value.get("props").cloned().unwrap_or_else(|| json!({})),
        "entities": value.get("entities").cloned().unwrap_or_else(|| json!([]))
    })
}

fn path_file_stem_string(path: &std::path::Path) -> String {
    path.file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_string()
}

pub(crate) fn persist_media_workspace_catalog(state: &State<'_, AppState>) -> Result<(), String> {
    let assets = with_store(state, |store| Ok(store.media_assets.clone()))?;
    write_json_value(
        &media_root(state)?.join("catalog.json"),
        &json!({
            "version": 1,
            "assets": assets,
        }),
    )
}

pub(crate) fn persist_cover_workspace_catalog(state: &State<'_, AppState>) -> Result<(), String> {
    let assets = with_store(state, |store| Ok(store.cover_assets.clone()))?;
    write_json_value(
        &cover_root(state)?.join("catalog.json"),
        &json!({
            "version": 1,
            "assets": assets,
        }),
    )
}

pub fn handle_library_channel(
    app: &AppHandle,
    state: &State<'_, AppState>,
    channel: &str,
    payload: &Value,
) -> Option<Result<Value, String>> {
    if !matches!(
        channel,
        "knowledge:list"
            | "knowledge:list-youtube"
            | "knowledge:docs:list"
            | "knowledge:delete-youtube"
            | "knowledge:retry-youtube-subtitle"
            | "knowledge:youtube-regenerate-summaries"
            | "knowledge:read-youtube-subtitle"
            | "knowledge:delete"
            | "knowledge:transcribe"
            | "knowledge:docs:add-files"
            | "knowledge:docs:add-folder"
            | "knowledge:docs:add-obsidian-vault"
            | "knowledge:docs:delete-source"
            | "media:list"
            | "media:open-root"
            | "media:open"
            | "media:update"
            | "media:bind"
            | "media:delete"
            | "media:import-files"
            | "animation-elements:list"
            | "animation-elements:open-root"
            | "animation-elements:save"
            | "animation-elements:delete"
            | "cover:list"
            | "cover:open-root"
            | "cover:open"
            | "cover:save-template-image"
            | "cover:generate"
    ) {
        return None;
    }
    Some((|| -> Result<Value, String> {
        match channel {
            "knowledge:list" => {
                let _ = ensure_store_hydrated_for_knowledge(state);
                with_store(state, |store| {
                    let mut items = store.knowledge_notes.clone();
                    items.sort_by(|a, b| b.created_at.cmp(&a.created_at));
                    Ok(json!(items))
                })
            }
            "knowledge:list-youtube" => {
                let _ = ensure_store_hydrated_for_knowledge(state);
                with_store(state, |store| {
                    let mut items = store.youtube_videos.clone();
                    items.sort_by(|a, b| b.created_at.cmp(&a.created_at));
                    Ok(json!(items))
                })
            }
            "knowledge:docs:list" => {
                let _ = ensure_store_hydrated_for_knowledge(state);
                with_store(state, |store| {
                    let mut items = store.document_sources.clone();
                    items.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
                    Ok(json!(items))
                })
            }
            "knowledge:delete-youtube" => {
                let video_id = payload_value_as_string(payload).unwrap_or_default();
                let result = with_store_mut(state, |store| {
                    store.youtube_videos.retain(|item| item.id != video_id);
                    Ok(json!({ "success": true }))
                })?;
                let _ = app.emit(
                    "knowledge:youtube-video-updated",
                    json!({ "noteId": video_id, "status": "deleted" }),
                );
                Ok(result)
            }
            "knowledge:retry-youtube-subtitle" => {
                let video_id = payload_value_as_string(payload).unwrap_or_default();
                let result = with_store_mut(state, |store| {
                    let Some(video) = store
                        .youtube_videos
                        .iter_mut()
                        .find(|item| item.id == video_id)
                    else {
                        return Ok(json!({ "success": false, "error": "视频记录不存在" }));
                    };
                    let subtitle = video
                        .subtitle_content
                        .clone()
                        .filter(|item| !item.trim().is_empty())
                        .unwrap_or_else(|| {
                            format!(
                                "RedBox recovered subtitle placeholder\n\n标题：{}\n链接：{}\n\n{}",
                                video.title, video.video_url, video.description
                            )
                        });
                    video.subtitle_content = Some(subtitle.clone());
                    video.has_subtitle = true;
                    video.status = Some("completed".to_string());
                    Ok(json!({ "success": true, "subtitleContent": subtitle }))
                })?;
                let _ = app.emit(
                    "knowledge:youtube-video-updated",
                    json!({ "noteId": video_id, "status": "completed" }),
                );
                Ok(result)
            }
            "knowledge:youtube-regenerate-summaries" => {
                let settings_snapshot = with_store(state, |store| Ok(store.settings.clone()))?;
                let candidates = with_store(state, |store| {
                    Ok(store
                        .youtube_videos
                        .iter()
                        .filter(|item| {
                            item.has_subtitle
                                && item.summary.as_deref().unwrap_or("").trim().is_empty()
                        })
                        .map(|item| {
                            (
                                item.id.clone(),
                                item.title.clone(),
                                item.subtitle_content.clone().unwrap_or_default(),
                            )
                        })
                        .collect::<Vec<_>>())
                })?;
                let mut updates = Vec::new();
                for (video_id, title, subtitle) in &candidates {
                    if subtitle.trim().is_empty() {
                        continue;
                    }
                    let prompt = format!(
                    "请基于下面的视频字幕，输出一段中文摘要，控制在 120 字以内。\n\n标题：{}\n\n字幕：\n{}",
                    title, subtitle
                );
                    let summary =
                        generate_response_with_settings(&settings_snapshot, None, &prompt);
                    updates.push((video_id.clone(), summary));
                }
                let updated_count = updates.len();
                with_store_mut(state, |store| {
                    for (video_id, summary) in &updates {
                        if let Some(video) = store
                            .youtube_videos
                            .iter_mut()
                            .find(|item| item.id == *video_id)
                        {
                            video.summary = Some(summary.clone());
                        }
                    }
                    Ok(())
                })?;
                Ok(json!({ "success": true, "updated": updated_count }))
            }
            "knowledge:read-youtube-subtitle" => {
                let id = payload_value_as_string(payload).unwrap_or_default();
                with_store(state, |store| {
                    let content = store
                        .youtube_videos
                        .iter()
                        .find(|item| item.id == id || item.video_id == id)
                        .and_then(|item| item.subtitle_content.clone())
                        .unwrap_or_default();
                    Ok(json!(content))
                })
            }
            "knowledge:delete" => {
                let note_id = payload_value_as_string(payload).unwrap_or_default();
                let result = with_store_mut(state, |store| {
                    let before = store.knowledge_notes.len();
                    store.knowledge_notes.retain(|item| item.id != note_id);
                    if before == store.knowledge_notes.len() {
                        return Ok(json!({ "success": false, "error": "笔记不存在" }));
                    }
                    Ok(json!({ "success": true }))
                })?;
                let _ = app.emit("knowledge:note-updated", json!({ "noteId": note_id }));
                Ok(result)
            }
            "knowledge:transcribe" => {
                let note_id = payload_value_as_string(payload).unwrap_or_default();
                let settings_snapshot = with_store(state, |store| Ok(store.settings.clone()))?;
                let note_snapshot = with_store(state, |store| {
                    Ok(store
                        .knowledge_notes
                        .iter()
                        .find(|item| item.id == note_id)
                        .cloned())
                })?;
                let Some(note_snapshot) = note_snapshot else {
                    return Ok(json!({ "success": false, "error": "笔记不存在" }));
                };
                let transcript = if let Some(video_source) = note_snapshot
                    .video
                    .clone()
                    .or(note_snapshot.video_url.clone())
                    .filter(|item| !item.trim().is_empty())
                {
                    if let Some((endpoint, api_key, model_name)) =
                        resolve_transcription_settings(&settings_snapshot)
                    {
                        let temp_dir = store_root(state)?.join("tmp");
                        fs::create_dir_all(&temp_dir).map_err(|error| error.to_string())?;
                        let target_path = temp_dir.join(format!("knowledge-{}-media", note_id));
                        let source_path = resolve_local_path(&video_source);
                        let mime_type = if video_source.ends_with(".mp3")
                            || video_source.ends_with(".wav")
                            || video_source.ends_with(".m4a")
                        {
                            "audio/*"
                        } else {
                            "video/*"
                        };
                        let local_media_path = if let Some(path) =
                            source_path.filter(|path| path.exists())
                        {
                            path
                        } else {
                            let bytes = run_curl_bytes("GET", &video_source, None, &[], None)?;
                            fs::write(&target_path, bytes).map_err(|error| error.to_string())?;
                            target_path.clone()
                        };
                        run_curl_transcription(
                            &endpoint,
                            api_key.as_deref(),
                            &model_name,
                            &local_media_path,
                            mime_type,
                        )
                        .unwrap_or_else(|_| {
                            format!(
                                "RedBox transcript fallback\n\n标题：{}\n\n{}",
                                note_snapshot.title,
                                note_snapshot.content.chars().take(240).collect::<String>()
                            )
                        })
                    } else {
                        format!(
                            "RedBox transcript fallback\n\n标题：{}\n\n{}",
                            note_snapshot.title,
                            note_snapshot.content.chars().take(240).collect::<String>()
                        )
                    }
                } else {
                    format!(
                        "RedBox transcript fallback\n\n标题：{}\n\n{}",
                        note_snapshot.title,
                        note_snapshot.content.chars().take(240).collect::<String>()
                    )
                };
                let result = with_store_mut(state, |store| {
                    let Some(note) = store
                        .knowledge_notes
                        .iter_mut()
                        .find(|item| item.id == note_id)
                    else {
                        return Ok(json!({ "success": false, "error": "笔记不存在" }));
                    };
                    note.transcription_status = Some("completed".to_string());
                    note.transcript = Some(transcript.clone());
                    Ok(json!({
                        "success": true,
                        "transcript": note.transcript.clone(),
                    }))
                })?;
                let _ = app.emit(
                "knowledge:note-updated",
                json!({ "noteId": note_id, "hasTranscript": true, "transcriptionStatus": "completed" }),
            );
                Ok(result)
            }
            "knowledge:docs:add-files"
            | "knowledge:docs:add-folder"
            | "knowledge:docs:add-obsidian-vault" => {
                let (kind, folder_name, title) = match channel {
                    "knowledge:docs:add-files" => {
                        ("copied-file", "imported-files", "Imported Files")
                    }
                    "knowledge:docs:add-folder" => {
                        ("tracked-folder", "tracked-folder", "Tracked Folder")
                    }
                    _ => ("obsidian-vault", "obsidian-vault", "Obsidian Vault"),
                };

                let root = if channel == "knowledge:docs:add-files" {
                    let selected = pick_files_native("选择要导入的文档文件", false, true)?;
                    if selected.is_empty() {
                        return Ok(json!({ "success": false, "error": "未选择文件" }));
                    }
                    let batch_root =
                        knowledge_root(state)?.join(format!("{}-{}", folder_name, now_ms()));
                    fs::create_dir_all(&batch_root).map_err(|error| error.to_string())?;
                    for file in &selected {
                        let _ = copy_file_into_dir(file, &batch_root)?;
                    }
                    batch_root
                } else {
                    let selected = pick_files_native(
                        if channel == "knowledge:docs:add-folder" {
                            "选择要追踪的文件夹"
                        } else {
                            "选择 Obsidian Vault 文件夹"
                        },
                        true,
                        false,
                    )?;
                    if let Some(folder) = selected.into_iter().next() {
                        folder
                    } else {
                        return Ok(json!({ "success": false, "error": "未选择文件夹" }));
                    }
                };
                if !root.exists() {
                    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
                }
                let file_count = count_files_in_dir(&root)?;
                let sample_files = collect_sample_files(&root, 6)?;
                let fallback_name = root
                    .file_name()
                    .and_then(|value| value.to_str())
                    .filter(|value| !value.trim().is_empty())
                    .unwrap_or(title)
                    .to_string();
                let display_name = format!(
                    "{} · {}",
                    fallback_name,
                    with_store(state, |store| Ok(store.active_space_id.clone()))?
                );
                let now = now_iso();
                let source = with_store_mut(state, |store| {
                    if let Some(existing) = store
                        .document_sources
                        .iter_mut()
                        .find(|item| item.root_path == root.display().to_string())
                    {
                        existing.file_count = file_count;
                        existing.sample_files = sample_files.clone();
                        existing.updated_at = now.clone();
                        return Ok(existing.clone());
                    }
                    let source = DocumentKnowledgeSourceRecord {
                        id: make_id("doc-source"),
                        kind: kind.to_string(),
                        name: display_name,
                        root_path: root.display().to_string(),
                        locked: kind != "tracked-folder",
                        indexing: false,
                        index_error: None,
                        file_count,
                        sample_files: sample_files.clone(),
                        created_at: now.clone(),
                        updated_at: now,
                    };
                    store.document_sources.push(source.clone());
                    Ok(source)
                })?;
                let _ = app.emit("knowledge:docs-updated", json!({ "sourceId": source.id }));
                Ok(json!({ "success": true, "source": source }))
            }
            "knowledge:docs:delete-source" => {
                let source_id = payload_value_as_string(payload).unwrap_or_default();
                let result = with_store_mut(state, |store| {
                    let before = store.document_sources.len();
                    store.document_sources.retain(|item| item.id != source_id);
                    if before == store.document_sources.len() {
                        return Ok(json!({ "success": false, "error": "文档源不存在" }));
                    }
                    Ok(json!({ "success": true }))
                })?;
                let _ = app.emit("knowledge:docs-updated", json!({ "sourceId": source_id }));
                Ok(result)
            }
            "media:list" => {
                let _ = ensure_store_hydrated_for_media(state);
                with_store(state, |store| {
                    let mut assets = store.media_assets.clone();
                    assets.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
                    Ok(json!({ "success": true, "assets": assets }))
                })
            }
            "media:open-root" => {
                let root = media_root(state)?;
                open::that(&root).map_err(|error| error.to_string())?;
                Ok(json!({ "success": true, "path": root.display().to_string() }))
            }
            "media:open" => {
                let asset_id = payload_string(payload, "assetId").unwrap_or_default();
                let asset = with_store(state, |store| {
                    Ok(store
                        .media_assets
                        .iter()
                        .find(|item| item.id == asset_id)
                        .cloned())
                })?;
                let Some(asset) = asset else {
                    return Ok(json!({ "success": false, "error": "媒体资产不存在" }));
                };
                let relative_media_path = asset.relative_path.clone().and_then(|rel| {
                    media_root(state)
                        .ok()
                        .map(|root| root.join(rel).display().to_string())
                });
                if let Some(path) = asset.absolute_path.clone().or(relative_media_path) {
                    open::that(&path).map_err(|error| error.to_string())?;
                    return Ok(json!({ "success": true, "path": path }));
                }
                Ok(json!({ "success": false, "error": "媒体资产没有可打开的文件路径" }))
            }
            "media:update" => {
                let result = with_store_mut(state, |store| {
                    let asset_id = payload_string(payload, "assetId").unwrap_or_default();
                    let Some(asset) = store
                        .media_assets
                        .iter_mut()
                        .find(|item| item.id == asset_id)
                    else {
                        return Ok(json!({ "success": false, "error": "媒体资产不存在" }));
                    };
                    asset.title = normalize_optional_string(payload_string(payload, "title"));
                    asset.project_id =
                        normalize_optional_string(payload_string(payload, "projectId"));
                    asset.prompt = normalize_optional_string(payload_string(payload, "prompt"));
                    asset.updated_at = now_iso();
                    Ok(json!({ "success": true, "asset": asset.clone() }))
                })?;
                persist_media_workspace_catalog(state)?;
                Ok(result)
            }
            "media:bind" => {
                let result = with_store_mut(state, |store| {
                    let asset_id = payload_string(payload, "assetId").unwrap_or_default();
                    let manuscript_path =
                        normalize_optional_string(payload_string(payload, "manuscriptPath"));
                    let Some(asset) = store
                        .media_assets
                        .iter_mut()
                        .find(|item| item.id == asset_id)
                    else {
                        return Ok(json!({ "success": false, "error": "媒体资产不存在" }));
                    };
                    asset.bound_manuscript_path = manuscript_path;
                    asset.updated_at = now_iso();
                    Ok(json!({ "success": true, "asset": asset.clone() }))
                })?;
                persist_media_workspace_catalog(state)?;
                Ok(result)
            }
            "media:delete" => {
                let result = with_store_mut(state, |store| {
                    let asset_id = payload_string(payload, "assetId").unwrap_or_default();
                    let before = store.media_assets.len();
                    store.media_assets.retain(|item| item.id != asset_id);
                    if before == store.media_assets.len() {
                        return Ok(json!({ "success": false, "error": "媒体资产不存在" }));
                    }
                    Ok(json!({ "success": true }))
                })?;
                persist_media_workspace_catalog(state)?;
                Ok(result)
            }
            "media:import-files" => {
                let selected = pick_files_native("选择要导入媒体库的文件", false, true)?;
                if selected.is_empty() {
                    return Ok(json!({ "success": false, "error": "未选择文件" }));
                }
                let imports_root = media_root(state)?.join("imports");
                fs::create_dir_all(&imports_root).map_err(|error| error.to_string())?;
                let imported = with_store_mut(state, |store| {
                    let mut assets = Vec::new();
                    for file in &selected {
                        let (relative_name, target) = copy_file_into_dir(file, &imports_root)?;
                        let (mime_type, _kind, _) = guess_mime_and_kind(&target);
                        let asset = MediaAssetRecord {
                            id: make_id("media"),
                            source: "imported".to_string(),
                            project_id: None,
                            title: file
                                .file_stem()
                                .and_then(|value| value.to_str())
                                .map(ToString::to_string),
                            prompt: None,
                            provider: None,
                            provider_template: None,
                            model: None,
                            aspect_ratio: None,
                            size: None,
                            quality: None,
                            mime_type: Some(mime_type),
                            relative_path: Some(format!("imports/{}", relative_name)),
                            bound_manuscript_path: None,
                            created_at: now_iso(),
                            updated_at: now_iso(),
                            absolute_path: Some(target.display().to_string()),
                            preview_url: Some(file_url_for_path(&target)),
                            exists: true,
                        };
                        store.media_assets.push(asset.clone());
                        assets.push(asset);
                    }
                    Ok(assets)
                })?;
                persist_media_workspace_catalog(state)?;
                Ok(json!({ "success": true, "assets": imported, "imported": imported.len() }))
            }
            "animation-elements:list" => {
                let root = remotion_elements_root(state)?;
                let mut items = builtin_animation_elements();
                if let Ok(entries) = fs::read_dir(&root) {
                    for entry in entries.flatten() {
                        let path = entry.path();
                        if !path.is_file()
                            || path.extension().and_then(|value| value.to_str()) != Some("json")
                        {
                            continue;
                        }
                        if let Ok(raw) = fs::read_to_string(&path) {
                            if let Ok(parsed) = serde_json::from_str::<Value>(&raw) {
                                items.push(animation_element_public_value(&parsed));
                            }
                        }
                    }
                }
                Ok(json!({ "success": true, "items": items }))
            }
            "animation-elements:open-root" => {
                let root = remotion_elements_root(state)?;
                open::that(&root).map_err(|error| error.to_string())?;
                Ok(json!({ "success": true, "path": root.display().to_string() }))
            }
            "animation-elements:save" => {
                let root = remotion_elements_root(state)?;
                let name =
                    payload_string(payload, "name").unwrap_or_else(|| "未命名动画元素".to_string());
                let layer = payload.get("layer").cloned().unwrap_or_else(|| json!({}));
                let entities = layer
                    .get("entities")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                let has_non_text_entity = entities.iter().any(|entity| {
                    entity
                        .get("type")
                        .and_then(Value::as_str)
                        .map(|value| value != "text")
                        .unwrap_or(false)
                });
                if !has_non_text_entity {
                    return Ok(
                        json!({ "success": false, "error": "纯文字动画不应保存到共享动画元素库" }),
                    );
                }
                let file_name = format!("{}.json", slug_from_relative_path(&name));
                let file_path = root.join(file_name);
                let saved = json!({
                    "id": payload_string(&layer, "id").unwrap_or_else(|| make_id("animation-element")),
                    "name": name,
                    "storageKey": path_file_stem_string(&file_path),
                    "source": "workspace",
                    "componentType": layer.get("componentType").cloned().unwrap_or_else(|| json!("scene-sequence")),
                    "durationMs": layer.get("durationMs").cloned().unwrap_or_else(|| json!(2000)),
                    "renderMode": layer.get("renderMode").cloned().unwrap_or_else(|| json!("motion-layer")),
                    "props": layer.get("props").cloned().unwrap_or_else(|| json!({})),
                    "entities": layer.get("entities").cloned().unwrap_or_else(|| json!([]))
                });
                write_json_value(&file_path, &saved)?;
                Ok(
                    json!({ "success": true, "item": animation_element_public_value(&saved), "path": file_path.display().to_string() }),
                )
            }
            "animation-elements:delete" => {
                let root = remotion_elements_root(state)?;
                let storage_key = payload_string(payload, "storageKey")
                    .or_else(|| payload_value_as_string(payload))
                    .unwrap_or_default();
                if storage_key.starts_with("builtin:") {
                    return Ok(json!({ "success": false, "error": "内置元素不能删除" }));
                }
                let file_name = format!("{}.json", slug_from_relative_path(&storage_key));
                let file_path = root.join(file_name);
                if !file_path.exists() {
                    return Ok(json!({ "success": false, "error": "元素不存在" }));
                }
                fs::remove_file(&file_path).map_err(|error| error.to_string())?;
                Ok(json!({ "success": true }))
            }
            "cover:list" => {
                let _ = ensure_store_hydrated_for_cover(state);
                with_store(state, |store| {
                    let mut assets = store.cover_assets.clone();
                    assets.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
                    Ok(json!({ "success": true, "assets": assets }))
                })
            }
            "cover:open-root" => {
                let root = cover_root(state)?;
                open::that(&root).map_err(|error| error.to_string())?;
                Ok(json!({ "success": true, "path": root.display().to_string() }))
            }
            "cover:open" => {
                let asset_id = payload_string(payload, "assetId").unwrap_or_default();
                let asset = with_store(state, |store| {
                    Ok(store
                        .cover_assets
                        .iter()
                        .find(|item| item.id == asset_id)
                        .cloned())
                })?;
                let Some(asset) = asset else {
                    return Ok(json!({ "success": false, "error": "封面资产不存在" }));
                };
                let relative_cover_path = asset.relative_path.clone().and_then(|rel| {
                    cover_root(state)
                        .ok()
                        .map(|root| root.join(rel).display().to_string())
                });
                if let Some(path) = relative_cover_path.or_else(|| asset.preview_url.clone()) {
                    open::that(&path).map_err(|error| error.to_string())?;
                    return Ok(json!({ "success": true, "path": path }));
                }
                Ok(json!({ "success": false, "error": "封面资产没有可打开的路径" }))
            }
            "cover:save-template-image" => {
                let image_source = payload_string(payload, "imageSource").unwrap_or_default();
                if image_source.is_empty() {
                    return Ok(json!({ "success": false, "error": "缺少模板图" }));
                }
                if let Some(source_path) =
                    resolve_local_path(&image_source).filter(|path| path.exists())
                {
                    let file_name = source_path
                        .file_name()
                        .and_then(|value| value.to_str())
                        .map(|value| value.to_string())
                        .unwrap_or_else(|| format!("cover-template-{}.png", now_ms()));
                    let relative = format!("templates/{}", normalize_relative_path(&file_name));
                    let target = cover_root(state)?.join(&relative);
                    if let Some(parent) = target.parent() {
                        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
                    }
                    fs::copy(&source_path, &target).map_err(|error| error.to_string())?;
                    return Ok(json!({
                        "success": true,
                        "previewUrl": file_url_for_path(&target),
                        "relativePath": relative,
                    }));
                }
                Ok(json!({ "success": true, "previewUrl": image_source }))
            }
            "cover:generate" => {
                let count = payload_field(payload, "count")
                    .and_then(|value| value.as_i64())
                    .unwrap_or(1)
                    .clamp(1, 4);
                let template_name =
                    normalize_optional_string(payload_string(payload, "templateName"));
                let provider = normalize_optional_string(payload_string(payload, "provider"));
                let provider_template =
                    normalize_optional_string(payload_string(payload, "providerTemplate"));
                let model = normalize_optional_string(payload_string(payload, "model"));
                let quality = normalize_optional_string(payload_string(payload, "quality"));
                let titles = payload_field(payload, "titles")
                    .and_then(|value| value.as_array())
                    .cloned()
                    .unwrap_or_default();
                let prompt = titles
                    .iter()
                    .filter_map(|item| item.get("text").and_then(|value| value.as_str()))
                    .collect::<Vec<_>>()
                    .join(" / ");
                let settings_snapshot = with_store(state, |store| Ok(store.settings.clone()))?;
                let real_image_config = resolve_image_generation_settings(&settings_snapshot);
                let created = with_store_mut(state, |store| {
                    let mut assets = Vec::new();
                    for index in 0..count {
                        let file_name = format!("cover-{}-{}.png", now_ms(), index + 1);
                        let relative_path = format!("generated/{}", file_name);
                        let absolute_path = cover_root(state)?.join(&relative_path);
                        let base_title = template_name
                            .clone()
                            .unwrap_or_else(|| "RedBox Cover".to_string());
                        let asset_title = if count > 1 {
                            format!("{base_title} {}", index + 1)
                        } else {
                            base_title
                        };
                        let mut wrote_real_asset = false;
                        if let Some((endpoint, api_key, default_model, _provider, _template)) =
                            &real_image_config
                        {
                            if let Ok(response) = run_image_generation_request(
                                endpoint,
                                api_key.as_deref(),
                                model
                                    .clone()
                                    .unwrap_or_else(|| default_model.clone())
                                    .as_str(),
                                &prompt,
                                1,
                                None,
                                quality.as_deref(),
                            ) {
                                if let Some(item) = extract_first_media_result(&response) {
                                    if write_generated_image_asset(&absolute_path, item).is_ok() {
                                        wrote_real_asset = true;
                                    }
                                }
                            }
                        }
                        if !wrote_real_asset {
                            write_placeholder_svg(
                                &absolute_path,
                                &asset_title,
                                &prompt.chars().take(48).collect::<String>(),
                                "#F2B544",
                            )?;
                        }
                        let asset = CoverAssetRecord {
                            id: make_id("cover"),
                            title: Some(asset_title),
                            template_name: template_name.clone(),
                            prompt: normalize_optional_string(Some(prompt.clone())),
                            provider: provider.clone(),
                            provider_template: provider_template.clone(),
                            model: model.clone(),
                            aspect_ratio: Some("3:4".to_string()),
                            size: None,
                            quality: quality.clone(),
                            relative_path: Some(relative_path),
                            preview_url: Some(file_url_for_path(&absolute_path)),
                            exists: true,
                            updated_at: now_iso(),
                        };
                        store.cover_assets.push(asset.clone());
                        assets.push(asset);
                    }
                    store.work_items.push(create_work_item(
                    "cover-generation",
                    template_name.clone().unwrap_or_else(|| "封面生成".to_string()),
                    normalize_optional_string(Some(if real_image_config.is_some() {
                        "RedBox 已尝试通过已配置图片 endpoint 生成封面。".to_string()
                    } else {
                        "RedBox 已保存封面生成请求；当前缺少图片 endpoint 配置，已生成可预览的本地 SVG 方案。".to_string()
                    })),
                    normalize_optional_string(Some(prompt.clone())),
                    None,
                    2,
                ));
                    Ok(assets)
                })?;
                persist_cover_workspace_catalog(state)?;
                Ok(json!({ "success": true, "assets": created }))
            }
            _ => unreachable!(),
        }
    })())
}
