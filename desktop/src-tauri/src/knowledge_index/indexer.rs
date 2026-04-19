use std::path::{Path, PathBuf};
use std::hash::{DefaultHasher, Hasher};

use serde_json::Value;
use tauri::{AppHandle, Emitter, State};

use crate::{
    knowledge_index::{
        catalog::{replace_catalog, KnowledgeCatalogSummary},
        fingerprint::fingerprint_file,
        mark_indexed_now,
    },
    now_iso, workspace_root, AppState, DocumentKnowledgeSourceRecord, KnowledgeNoteRecord,
    YoutubeVideoRecord,
};

type IndexedFileRow = (String, String, i64, i64, String, String);

fn preview_text(input: &str, max_chars: usize) -> String {
    let compact = input.split_whitespace().collect::<Vec<_>>().join(" ");
    compact.chars().take(max_chars).collect::<String>()
}

fn detect_language(input: &str) -> Option<String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return None;
    }
    let chinese = trimmed.chars().filter(|ch| ('\u{4e00}'..='\u{9fff}').contains(ch)).count();
    let ascii = trimmed.chars().filter(|ch| ch.is_ascii_alphabetic()).count();
    if chinese == 0 && ascii == 0 {
        return None;
    }
    if chinese >= ascii {
        Some("zh".to_string())
    } else {
        Some("en".to_string())
    }
}

fn summarize_note(item: KnowledgeNoteRecord) -> KnowledgeCatalogSummary {
    let tags = item.tags.clone().unwrap_or_default();
    let preview = item
        .excerpt
        .clone()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| preview_text(&item.content, 280));
    KnowledgeCatalogSummary {
        item_id: item.id.clone(),
        kind: "redbook-note".to_string(),
        note_type: item.r#type.clone(),
        capture_kind: item.capture_kind.clone(),
        title: item.title,
        author: item.author,
        site_name: item.site_name,
        source_url: item.source_url,
        folder_path: item.folder_path.clone(),
        root_path: item.folder_path,
        cover_url: item.cover,
        thumbnail_url: None,
        preview_text: preview.clone(),
        created_at: item.created_at.clone(),
        updated_at: item.created_at,
        language: detect_language(&format!("{} {}", preview, tags.join(" "))),
        has_video: item.video.is_some(),
        has_transcript: item.transcript.as_deref().is_some_and(|value| !value.trim().is_empty()),
        tags,
        status: item.transcription_status,
        sample_files: Vec::new(),
        file_count: 0,
        item_hash: String::new(),
    }
}

fn summarize_video(item: YoutubeVideoRecord) -> KnowledgeCatalogSummary {
    let preview = item
        .summary
        .clone()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| preview_text(&item.description, 280));
    KnowledgeCatalogSummary {
        item_id: item.id.clone(),
        kind: "youtube-video".to_string(),
        note_type: None,
        capture_kind: None,
        title: item.title,
        author: "YouTube".to_string(),
        site_name: None,
        source_url: Some(item.video_url.clone()),
        folder_path: item.folder_path.clone(),
        root_path: item.folder_path,
        cover_url: None,
        thumbnail_url: Some(item.thumbnail_url),
        preview_text: preview.clone(),
        created_at: item.created_at.clone(),
        updated_at: item.created_at,
        language: detect_language(&preview),
        has_video: true,
        has_transcript: item
            .subtitle_content
            .as_deref()
            .is_some_and(|value| !value.trim().is_empty()),
        tags: Vec::new(),
        status: item.status,
        sample_files: Vec::new(),
        file_count: 0,
        item_hash: String::new(),
    }
}

fn summarize_document_source(item: DocumentKnowledgeSourceRecord) -> KnowledgeCatalogSummary {
    let preview = if item.sample_files.is_empty() {
        item.root_path.clone()
    } else {
        preview_text(&item.sample_files.join(" "), 280)
    };
    KnowledgeCatalogSummary {
        item_id: item.id.clone(),
        kind: "document-source".to_string(),
        note_type: None,
        capture_kind: None,
        title: item.name,
        author: String::new(),
        site_name: None,
        source_url: None,
        folder_path: None,
        root_path: Some(item.root_path),
        cover_url: None,
        thumbnail_url: None,
        preview_text: preview.clone(),
        created_at: item.created_at.clone(),
        updated_at: item.updated_at.clone(),
        language: detect_language(&preview),
        has_video: false,
        has_transcript: false,
        tags: Vec::new(),
        status: if item.indexing {
            Some("indexing".to_string())
        } else {
            item.index_error.clone()
        },
        sample_files: item.sample_files,
        file_count: item.file_count,
        item_hash: String::new(),
    }
}

fn file_row_for_path(
    item_id: &str,
    path: &Path,
    role: &str,
) -> Result<Option<IndexedFileRow>, String> {
    if !path.exists() || !path.is_file() {
        return Ok(None);
    }
    let fingerprint = fingerprint_file(path)?;
    Ok(Some((
        path.display().to_string(),
        item_id.to_string(),
        fingerprint.size_bytes,
        fingerprint.mtime_ms,
        fingerprint.content_hash,
        role.to_string(),
    )))
}

fn item_hash_from_rows(rows: &[IndexedFileRow]) -> String {
    let mut hasher = DefaultHasher::new();
    for (_, _, _, _, content_hash, role) in rows {
        hasher.write(role.as_bytes());
        hasher.write(content_hash.as_bytes());
    }
    format!("{:016x}", hasher.finish())
}

fn build_rows_for_note(item: &KnowledgeCatalogSummary) -> Result<Vec<IndexedFileRow>, String> {
    let Some(folder_path) = item.folder_path.as_ref() else {
        return Ok(Vec::new());
    };
    let base = PathBuf::from(folder_path);
    let mut rows = Vec::new();
    for (name, role) in [
        ("meta.json", "meta"),
        ("content.md", "content"),
        ("content.html", "html"),
        ("transcript.txt", "transcript"),
        ("subtitle.txt", "subtitle"),
    ] {
        if let Some(row) = file_row_for_path(&item.item_id, &base.join(name), role)? {
            rows.push(row);
        }
    }
    Ok(rows)
}

fn build_rows_for_video(item: &KnowledgeCatalogSummary) -> Result<Vec<IndexedFileRow>, String> {
    let Some(folder_path) = item.folder_path.as_ref() else {
        return Ok(Vec::new());
    };
    let base = PathBuf::from(folder_path);
    let mut rows = Vec::new();
    for (name, role) in [
        ("meta.json", "meta"),
        ("thumbnail.jpg", "thumb"),
        ("subtitle.txt", "subtitle"),
        ("subtitle.srt", "subtitle"),
        ("subtitle.vtt", "subtitle"),
    ] {
        if let Some(row) = file_row_for_path(&item.item_id, &base.join(name), role)? {
            rows.push(row);
        }
    }
    Ok(rows)
}

fn build_rows_for_doc_source(item: &KnowledgeCatalogSummary) -> Result<Vec<IndexedFileRow>, String> {
    let mut rows = Vec::new();
    if let Some(root_path) = item.root_path.as_ref() {
        let root = PathBuf::from(root_path);
        if root.is_file() {
            if let Some(row) = file_row_for_path(&item.item_id, &root, "asset")? {
                rows.push(row);
            }
        } else if root.is_dir() {
            for name in item.sample_files.iter().take(6) {
                let candidate = root.join(name);
                if let Some(row) = file_row_for_path(&item.item_id, &candidate, "asset")? {
                    rows.push(row);
                }
            }
        }
    }
    if rows.is_empty() {
        let mut hasher = DefaultHasher::new();
        hasher.write(
            format!(
                "{}:{}:{}",
                item.root_path.as_deref().unwrap_or(""),
                item.file_count,
                item.updated_at
            )
            .as_bytes(),
        );
        let pseudo_hash = format!("{:016x}", hasher.finish());
        rows.push((
            item.root_path.clone().unwrap_or_else(|| item.item_id.clone()),
            item.item_id.clone(),
            item.file_count,
            0,
            pseudo_hash,
            "asset".to_string(),
        ));
    }
    Ok(rows)
}

fn finalize_item_hash(items: &mut [KnowledgeCatalogSummary], rows: &[IndexedFileRow]) {
    let mut grouped = std::collections::HashMap::<String, Vec<IndexedFileRow>>::new();
    for row in rows {
        grouped.entry(row.1.clone()).or_default().push(row.clone());
    }
    for item in items {
        item.item_hash = grouped
            .get(&item.item_id)
            .map(|group| item_hash_from_rows(group))
            .unwrap_or_else(|| {
                let mut hasher = DefaultHasher::new();
                hasher.write(item.preview_text.as_bytes());
                format!("{:016x}", hasher.finish())
            });
    }
}

pub(crate) fn rebuild_catalog(
    app: &AppHandle,
    state: &State<'_, AppState>,
) -> Result<(), String> {
    let knowledge_root = workspace_root(state)?.join("knowledge");
    let mut items = Vec::new();
    let mut files = Vec::new();

    for note in crate::load_knowledge_notes_from_fs(&knowledge_root) {
        let summary = summarize_note(note);
        files.extend(build_rows_for_note(&summary)?);
        items.push(summary);
    }
    for video in crate::load_youtube_videos_from_fs(&knowledge_root) {
        let summary = summarize_video(video);
        files.extend(build_rows_for_video(&summary)?);
        items.push(summary);
    }
    for source in crate::load_document_sources_from_fs(&knowledge_root) {
        let summary = summarize_document_source(source);
        files.extend(build_rows_for_doc_source(&summary)?);
        items.push(summary);
    }

    finalize_item_hash(&mut items, &files);
    replace_catalog(state, &items, &files)?;
    mark_indexed_now(state)?;
    let _ = app.emit("knowledge:catalog-updated", Value::String(now_iso()));
    let _ = app.emit("knowledge:changed", serde_json::json!({ "at": now_iso() }));
    Ok(())
}
