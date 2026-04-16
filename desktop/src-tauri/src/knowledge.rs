use crate::persistence::{
    apply_workspace_hydration_snapshot, load_workspace_hydration_snapshot, with_store,
    with_store_mut,
};
use crate::workspace_loaders::read_json_file;
use crate::*;
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, State};

fn knowledge_docs_root(state: &State<'_, AppState>) -> Result<PathBuf, String> {
    let root = knowledge_root(state)?.join("docs");
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    Ok(root)
}

fn imported_docs_root(state: &State<'_, AppState>) -> Result<PathBuf, String> {
    let root = knowledge_docs_root(state)?.join("imported");
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    Ok(root)
}

fn youtube_entry_id(video_id: &str) -> String {
    let slug = slug_from_relative_path(video_id);
    if slug.is_empty() {
        make_id("youtube")
    } else {
        format!("youtube-{slug}")
    }
}

fn youtube_entry_dir(state: &State<'_, AppState>, entry_id: &str) -> Result<PathBuf, String> {
    let root = knowledge_root(state)?.join("youtube").join(entry_id);
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    Ok(root)
}

fn read_document_sources_index(state: &State<'_, AppState>) -> Result<Vec<Value>, String> {
    let path = knowledge_docs_root(state)?.join("sources.json");
    let value = read_json_value_or(&path, json!([]));
    Ok(value
        .as_array()
        .cloned()
        .or_else(|| {
            value
                .get("sources")
                .and_then(|item| item.as_array())
                .cloned()
        })
        .unwrap_or_default())
}

fn write_document_sources_index(
    state: &State<'_, AppState>,
    sources: &[Value],
) -> Result<(), String> {
    let path = knowledge_docs_root(state)?.join("sources.json");
    write_json_value(&path, &json!(sources))
}

fn refresh_knowledge_projection(state: &State<'_, AppState>) -> Result<(), String> {
    let root = with_store(state, |store| {
        active_space_workspace_root_from_store(&store, &store.active_space_id, &state.store_path)
    })?;
    let snapshot = load_workspace_hydration_snapshot(&root);
    with_store_mut(state, |store| {
        apply_workspace_hydration_snapshot(store, snapshot);
        Ok(())
    })?;
    Ok(())
}

fn refresh_knowledge_projection_and_emit(
    app: Option<&AppHandle>,
    state: &State<'_, AppState>,
    event: Option<(&str, Value)>,
) -> Result<(), String> {
    refresh_knowledge_projection(state)?;
    if let Some(app) = app {
        let _ = app.emit("knowledge:changed", json!({ "at": now_iso() }));
        if let Some((name, payload)) = event {
            let _ = app.emit(name, payload);
        }
    }
    Ok(())
}

fn remove_dir_if_exists(path: &Path) -> Result<(), String> {
    if path.exists() {
        fs::remove_dir_all(path).map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn is_workspace_managed_doc_root(state: &State<'_, AppState>, path: &Path) -> bool {
    imported_docs_root(state)
        .ok()
        .and_then(|root| fs::canonicalize(root).ok())
        .zip(fs::canonicalize(path).ok())
        .is_some_and(|(workspace_root, candidate)| candidate.starts_with(workspace_root))
}

pub(crate) fn save_youtube_note(
    app: &AppHandle,
    state: &State<'_, AppState>,
    input: &YoutubeSavePayload,
) -> Result<Value, String> {
    let _ = ensure_store_hydrated_for_knowledge(state);
    let existing = with_store(state, |store| {
        Ok(store
            .youtube_videos
            .iter()
            .find(|item| item.video_id == input.video_id || item.video_url == input.video_url)
            .cloned())
    })?;

    let entry_id = existing
        .as_ref()
        .map(|item| item.id.clone())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| youtube_entry_id(&input.video_id));
    let created_at = existing
        .as_ref()
        .map(|item| item.created_at.clone())
        .unwrap_or_else(now_iso);
    let summary = existing
        .as_ref()
        .and_then(|item| item.summary.clone())
        .unwrap_or_else(|| "RedBox captured this video for later migration work.".to_string());
    let subtitle_file = existing.as_ref().and_then(|item| {
        item.folder_path
            .as_ref()
            .and_then(|folder| read_json_file(Path::new(folder).join("meta.json").as_path()))
            .and_then(|meta| {
                meta.get("subtitleFile")
                    .or_else(|| meta.get("subtitle_file"))
                    .and_then(|value| value.as_str())
                    .map(ToString::to_string)
            })
    });
    let entry_dir = youtube_entry_dir(state, &entry_id)?;
    let meta_path = entry_dir.join("meta.json");
    let meta = json!({
        "id": entry_id,
        "videoId": input.video_id,
        "videoUrl": input.video_url,
        "title": input.title,
        "originalTitle": input.title,
        "description": input.description.clone().unwrap_or_default(),
        "summary": summary,
        "thumbnailUrl": input.thumbnail_url.clone().unwrap_or_default(),
        "hasSubtitle": existing.as_ref().map(|item| item.has_subtitle).unwrap_or(false),
        "status": existing
            .as_ref()
            .and_then(|item| item.status.clone())
            .unwrap_or_else(|| "completed".to_string()),
        "createdAt": created_at,
        "subtitleFile": subtitle_file,
    });
    write_json_value(&meta_path, &meta)?;
    refresh_knowledge_projection_and_emit(
        Some(app),
        state,
        Some((
            "knowledge:new-youtube-video",
            json!({
                "noteId": entry_id,
                "title": input.title,
                "status": "completed",
            }),
        )),
    )?;
    Ok(json!({
        "success": true,
        "duplicate": existing.is_some(),
        "migrated": existing.as_ref().is_some_and(|item| item.folder_path.is_none()),
        "noteId": entry_id,
    }))
}

pub(crate) fn delete_youtube_note(
    app: &AppHandle,
    state: &State<'_, AppState>,
    video_id: &str,
) -> Result<Value, String> {
    let _ = ensure_store_hydrated_for_knowledge(state);
    let existing = with_store(state, |store| {
        Ok(store
            .youtube_videos
            .iter()
            .find(|item| item.id == video_id)
            .cloned())
    })?;
    if let Some(video) = existing {
        if let Some(folder_path) = video.folder_path.as_deref() {
            remove_dir_if_exists(Path::new(folder_path))?;
            refresh_knowledge_projection_and_emit(
                Some(app),
                state,
                Some((
                    "knowledge:youtube-video-updated",
                    json!({ "noteId": video_id, "status": "deleted" }),
                )),
            )?;
            return Ok(json!({ "success": true }));
        }
    }
    with_store_mut(state, |store| {
        store.youtube_videos.retain(|item| item.id != video_id);
        Ok(())
    })?;
    let _ = app.emit(
        "knowledge:youtube-video-updated",
        json!({ "noteId": video_id, "status": "deleted" }),
    );
    let _ = app.emit("knowledge:changed", json!({ "at": now_iso() }));
    Ok(json!({ "success": true, "legacyFallback": true }))
}

pub(crate) fn retry_youtube_subtitle(
    app: &AppHandle,
    state: &State<'_, AppState>,
    video_id: &str,
) -> Result<Value, String> {
    let _ = ensure_store_hydrated_for_knowledge(state);
    let video = with_store(state, |store| {
        Ok(store
            .youtube_videos
            .iter()
            .find(|item| item.id == video_id)
            .cloned())
    })?;
    let Some(video) = video else {
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

    if let Some(folder_path) = video.folder_path.as_deref() {
        let folder = Path::new(folder_path);
        let meta_path = folder.join("meta.json");
        let mut meta = read_json_value_or(&meta_path, json!({}));
        let subtitle_file = meta
            .get("subtitleFile")
            .or_else(|| meta.get("subtitle_file"))
            .and_then(|value| value.as_str())
            .filter(|value| !value.trim().is_empty())
            .unwrap_or("subtitle.txt")
            .to_string();
        fs::write(folder.join(&subtitle_file), &subtitle).map_err(|error| error.to_string())?;
        if let Some(object) = meta.as_object_mut() {
            object.insert("hasSubtitle".to_string(), json!(true));
            object.insert("status".to_string(), json!("completed"));
            object.insert("subtitleFile".to_string(), json!(subtitle_file));
        }
        write_json_value(&meta_path, &meta)?;
        refresh_knowledge_projection_and_emit(
            Some(app),
            state,
            Some((
                "knowledge:youtube-video-updated",
                json!({ "noteId": video_id, "status": "completed" }),
            )),
        )?;
        return Ok(json!({ "success": true, "subtitleContent": subtitle }));
    }

    with_store_mut(state, |store| {
        let Some(target) = store
            .youtube_videos
            .iter_mut()
            .find(|item| item.id == video_id)
        else {
            return Ok(());
        };
        target.subtitle_content = Some(subtitle.clone());
        target.has_subtitle = true;
        target.status = Some("completed".to_string());
        Ok(())
    })?;
    let _ = app.emit(
        "knowledge:youtube-video-updated",
        json!({ "noteId": video_id, "status": "completed" }),
    );
    let _ = app.emit("knowledge:changed", json!({ "at": now_iso() }));
    Ok(json!({ "success": true, "subtitleContent": subtitle, "legacyFallback": true }))
}

pub(crate) fn save_youtube_summaries(
    state: &State<'_, AppState>,
    updates: &[(String, String)],
) -> Result<(), String> {
    let _ = ensure_store_hydrated_for_knowledge(state);
    let by_id = with_store(state, |store| {
        Ok(store
            .youtube_videos
            .iter()
            .map(|item| (item.id.clone(), item.folder_path.clone()))
            .collect::<std::collections::HashMap<_, _>>())
    })?;
    let mut legacy_ids = Vec::new();
    for (video_id, summary) in updates {
        if let Some(Some(folder_path)) = by_id.get(video_id) {
            let meta_path = Path::new(folder_path).join("meta.json");
            let mut meta = read_json_value_or(&meta_path, json!({}));
            if let Some(object) = meta.as_object_mut() {
                object.insert("summary".to_string(), json!(summary));
            }
            write_json_value(&meta_path, &meta)?;
        } else {
            legacy_ids.push((video_id.clone(), summary.clone()));
        }
    }
    if !legacy_ids.is_empty() {
        with_store_mut(state, |store| {
            for (video_id, summary) in &legacy_ids {
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
    }
    refresh_knowledge_projection(state)?;
    Ok(())
}

pub(crate) fn add_document_source(
    app: &AppHandle,
    state: &State<'_, AppState>,
    kind: &str,
    root_path: &Path,
    display_name: &str,
    locked: bool,
) -> Result<Value, String> {
    let now = now_iso();
    let file_count = count_files_in_dir(root_path)?;
    let sample_files = collect_sample_files(root_path, 6)?;
    let root_display = root_path.display().to_string();
    let mut sources = read_document_sources_index(state)?;
    let source = if let Some(existing) = sources.iter_mut().find(|item| {
        item.get("rootPath")
            .or_else(|| item.get("root_path"))
            .and_then(|value| value.as_str())
            == Some(root_display.as_str())
    }) {
        if let Some(object) = existing.as_object_mut() {
            object.insert("fileCount".to_string(), json!(file_count));
            object.insert("sampleFiles".to_string(), json!(sample_files.clone()));
            object.insert("updatedAt".to_string(), json!(now.clone()));
        }
        existing.clone()
    } else {
        let source = json!({
            "id": make_id("doc-source"),
            "kind": kind,
            "name": display_name,
            "rootPath": root_display,
            "locked": locked,
            "indexing": false,
            "indexError": Value::Null,
            "fileCount": file_count,
            "sampleFiles": sample_files,
            "createdAt": now,
            "updatedAt": now_iso(),
        });
        sources.push(source.clone());
        source
    };
    write_document_sources_index(state, &sources)?;
    refresh_knowledge_projection_and_emit(
        Some(app),
        state,
        Some((
            "knowledge:docs-updated",
            json!({ "sourceId": source.get("id").cloned().unwrap_or(Value::Null) }),
        )),
    )?;
    Ok(json!({ "success": true, "source": source }))
}

pub(crate) fn import_document_files(
    app: &AppHandle,
    state: &State<'_, AppState>,
    files: &[PathBuf],
    display_name: &str,
) -> Result<Value, String> {
    let source_id = make_id("doc-source");
    let batch_root = imported_docs_root(state)?.join(&source_id);
    fs::create_dir_all(&batch_root).map_err(|error| error.to_string())?;
    for file in files {
        let _ = copy_file_into_dir(file, &batch_root)?;
    }
    add_document_source(app, state, "copied-file", &batch_root, display_name, true)
}

pub(crate) fn delete_document_source(
    app: &AppHandle,
    state: &State<'_, AppState>,
    source_id: &str,
) -> Result<Value, String> {
    let _ = ensure_store_hydrated_for_knowledge(state);
    let existing = with_store(state, |store| {
        Ok(store
            .document_sources
            .iter()
            .find(|item| item.id == source_id)
            .cloned())
    })?;

    let mut sources = read_document_sources_index(state)?;
    let before = sources.len();
    sources.retain(|item| item.get("id").and_then(|value| value.as_str()) != Some(source_id));
    if before == sources.len() {
        return Ok(json!({ "success": false, "error": "文档源不存在" }));
    }
    write_document_sources_index(state, &sources)?;
    if let Some(source) = existing {
        let root = Path::new(&source.root_path);
        if is_workspace_managed_doc_root(state, root) {
            remove_dir_if_exists(root)?;
        }
    }
    refresh_knowledge_projection_and_emit(
        Some(app),
        state,
        Some(("knowledge:docs-updated", json!({ "sourceId": source_id }))),
    )?;
    Ok(json!({ "success": true }))
}

pub(crate) fn delete_note(
    app: &AppHandle,
    state: &State<'_, AppState>,
    note_id: &str,
) -> Result<Value, String> {
    let _ = ensure_store_hydrated_for_knowledge(state);
    let existing = with_store(state, |store| {
        Ok(store
            .knowledge_notes
            .iter()
            .find(|item| item.id == note_id)
            .cloned())
    })?;
    if let Some(note) = existing {
        if let Some(folder_path) = note.folder_path.as_deref() {
            remove_dir_if_exists(Path::new(folder_path))?;
            refresh_knowledge_projection_and_emit(
                Some(app),
                state,
                Some(("knowledge:note-updated", json!({ "noteId": note_id }))),
            )?;
            return Ok(json!({ "success": true }));
        }
    }
    with_store_mut(state, |store| {
        let before = store.knowledge_notes.len();
        store.knowledge_notes.retain(|item| item.id != note_id);
        if before == store.knowledge_notes.len() {
            return Ok(json!({ "success": false, "error": "笔记不存在" }));
        }
        Ok(json!({ "success": true, "legacyFallback": true }))
    })
}

pub(crate) fn persist_note_transcript(
    app: &AppHandle,
    state: &State<'_, AppState>,
    note_id: &str,
    transcript: &str,
) -> Result<Value, String> {
    let _ = ensure_store_hydrated_for_knowledge(state);
    let note = with_store(state, |store| {
        Ok(store
            .knowledge_notes
            .iter()
            .find(|item| item.id == note_id)
            .cloned())
    })?;
    let Some(note) = note else {
        return Ok(json!({ "success": false, "error": "笔记不存在" }));
    };

    if let Some(folder_path) = note.folder_path.as_deref() {
        let folder = Path::new(folder_path);
        let transcript_name = "transcript.md";
        fs::write(folder.join(transcript_name), transcript).map_err(|error| error.to_string())?;
        let meta_path = folder.join("meta.json");
        let mut meta = read_json_value_or(&meta_path, json!({}));
        if let Some(object) = meta.as_object_mut() {
            object.insert("transcriptFile".to_string(), json!(transcript_name));
            object.insert("transcriptionStatus".to_string(), json!("completed"));
        }
        write_json_value(&meta_path, &meta)?;
        refresh_knowledge_projection_and_emit(
            Some(app),
            state,
            Some((
                "knowledge:note-updated",
                json!({
                    "noteId": note_id,
                    "hasTranscript": true,
                    "transcriptionStatus": "completed",
                }),
            )),
        )?;
        return Ok(json!({
            "success": true,
            "transcript": transcript,
        }));
    }

    with_store_mut(state, |store| {
        let Some(target) = store
            .knowledge_notes
            .iter_mut()
            .find(|item| item.id == note_id)
        else {
            return Ok(());
        };
        target.transcription_status = Some("completed".to_string());
        target.transcript = Some(transcript.to_string());
        Ok(())
    })?;
    let _ = app.emit(
        "knowledge:note-updated",
        json!({
            "noteId": note_id,
            "hasTranscript": true,
            "transcriptionStatus": "completed",
        }),
    );
    let _ = app.emit("knowledge:changed", json!({ "at": now_iso() }));
    Ok(json!({ "success": true, "transcript": transcript, "legacyFallback": true }))
}
