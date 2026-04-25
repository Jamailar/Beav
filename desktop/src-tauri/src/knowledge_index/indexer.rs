use std::hash::{DefaultHasher, Hasher};
use std::path::{Path, PathBuf};

use serde_json::Value;
use tauri::{AppHandle, Emitter, State};

use crate::{
    knowledge_index::{
        advisor_source_id,
        canonical_store::{load_document_rows, replace_documents},
        catalog::{replace_catalog, KnowledgeCatalogSummary},
        citation_anchors::{build_anchors_for_blocks, replace_anchors, replace_anchors_for_source},
        document_blocks::{
            block_records_from_document, build_blocks_for_source_with_cache_policy, replace_blocks,
            replace_blocks_for_source, CanonicalCachePolicy,
        },
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
    let chinese = trimmed
        .chars()
        .filter(|ch| ('\u{4e00}'..='\u{9fff}').contains(ch))
        .count();
    let ascii = trimmed
        .chars()
        .filter(|ch| ch.is_ascii_alphabetic())
        .count();
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
        has_transcript: item
            .transcript
            .as_deref()
            .is_some_and(|value| !value.trim().is_empty()),
        tags,
        status: item.transcription_status,
        sample_files: Vec::new(),
        file_count: 0,
        item_hash: String::new(),
    }
}

fn summarize_video(item: YoutubeVideoRecord) -> KnowledgeCatalogSummary {
    let preview = if item.status.as_deref() == Some("failed") {
        item.subtitle_error
            .clone()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| preview_text(&item.description, 280))
    } else {
        item.summary
            .clone()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| preview_text(&item.description, 280))
    };
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

fn build_rows_for_doc_source(
    item: &KnowledgeCatalogSummary,
) -> Result<Vec<IndexedFileRow>, String> {
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
            item.root_path
                .clone()
                .unwrap_or_else(|| item.item_id.clone()),
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

pub(crate) fn rebuild_catalog(app: &AppHandle, state: &State<'_, AppState>) -> Result<(), String> {
    rebuild_catalog_with_cache_policy(app, state, CanonicalCachePolicy::CurrentParserOnly)
}

pub(crate) fn rebuild_catalog_reusing_unchanged_canonical(
    app: &AppHandle,
    state: &State<'_, AppState>,
) -> Result<(), String> {
    rebuild_catalog_with_cache_policy(app, state, CanonicalCachePolicy::ReuseUnchangedFingerprint)
}

fn rebuild_catalog_with_cache_policy(
    app: &AppHandle,
    state: &State<'_, AppState>,
    cache_policy: CanonicalCachePolicy,
) -> Result<(), String> {
    let knowledge_root = workspace_root(state)?.join("knowledge");
    let mut items = Vec::new();
    let mut files = Vec::new();
    let mut blocks = Vec::new();
    let mut anchors = Vec::new();
    let mut canonical_rows = Vec::new();

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
        let root_path = PathBuf::from(&source.root_path);
        if root_path.exists() {
            let indexed = build_blocks_for_source_with_cache_policy(
                state,
                &source.id,
                &source.name,
                &root_path,
                &source.updated_at,
                cache_policy,
            )?;
            anchors.extend(build_anchors_for_blocks(&indexed.blocks));
            blocks.extend(indexed.blocks);
            canonical_rows.extend(indexed.canonical_rows);
        }
        let summary = summarize_document_source(source);
        files.extend(build_rows_for_doc_source(&summary)?);
        items.push(summary);
    }
    let advisors = crate::with_store(state, |store| Ok(store.advisors.clone()))?;
    for advisor in advisors {
        let root_path = crate::advisor_knowledge_dir(state, &advisor.id)?;
        if !root_path.exists() {
            continue;
        }
        let indexed = build_blocks_for_source_with_cache_policy(
            state,
            &advisor_source_id(&advisor.id),
            &advisor.name,
            &root_path,
            &now_iso(),
            cache_policy,
        )?;
        anchors.extend(build_anchors_for_blocks(&indexed.blocks));
        blocks.extend(indexed.blocks);
        canonical_rows.extend(indexed.canonical_rows);
    }

    finalize_item_hash(&mut items, &files);
    replace_catalog(state, &items, &files)?;
    replace_documents(state, &canonical_rows)?;
    replace_blocks(state, &blocks)?;
    replace_anchors(state, &anchors)?;
    mark_indexed_now(state)?;
    let _ = app.emit("knowledge:catalog-updated", Value::String(now_iso()));
    let _ = app.emit("knowledge:changed", serde_json::json!({ "at": now_iso() }));
    Ok(())
}

pub(crate) fn rebuild_blocks_from_canonical(
    app: &AppHandle,
    state: &State<'_, AppState>,
    source_id: Option<&str>,
) -> Result<(), String> {
    let rows = load_document_rows(state, source_id)?;
    let mut blocks = Vec::new();
    for row in rows {
        let canonical: crate::document_parse::CanonicalDocument =
            serde_json::from_str(&row.canonical_json).map_err(|error| error.to_string())?;
        let (source_name, root_path) = source_context_for_canonical_row(state, &row)?;
        blocks.extend(block_records_from_document(
            &canonical,
            &source_name,
            &root_path,
            &row.updated_at,
        )?);
    }
    let anchors = build_anchors_for_blocks(&blocks);
    if let Some(source_id) = source_id {
        replace_blocks_for_source(state, source_id, &blocks)?;
        replace_anchors_for_source(state, source_id, &anchors)?;
    } else {
        replace_blocks(state, &blocks)?;
        replace_anchors(state, &anchors)?;
    }
    mark_indexed_now(state)?;
    let _ = app.emit("knowledge:catalog-updated", Value::String(now_iso()));
    let _ = app.emit("knowledge:changed", serde_json::json!({ "at": now_iso() }));
    Ok(())
}

fn source_context_for_canonical_row(
    state: &State<'_, AppState>,
    row: &crate::knowledge_index::canonical_store::CanonicalDocumentRow,
) -> Result<(String, PathBuf), String> {
    if let Some(advisor_id) = row.source_id.strip_prefix("advisor:") {
        let source_name = crate::with_store(state, |store| {
            Ok(store
                .advisors
                .iter()
                .find(|item| item.id == advisor_id)
                .map(|item| item.name.clone())
                .unwrap_or_else(|| row.source_id.clone()))
        })?;
        let root_path = crate::advisor_knowledge_dir(state, advisor_id)?;
        return Ok((source_name, root_path));
    }
    let document_source = crate::with_store(state, |store| {
        Ok(store
            .document_sources
            .iter()
            .find(|item| item.id == row.source_id)
            .cloned())
    })?;
    if let Some(source) = document_source {
        return Ok((source.name, PathBuf::from(source.root_path)));
    }
    let absolute_path = PathBuf::from(&row.absolute_path);
    let root_path = absolute_path
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| absolute_path.clone());
    Ok((row.source_id.clone(), root_path))
}
