use std::collections::HashSet;
use std::hash::{DefaultHasher, Hasher};
use std::path::{Path, PathBuf};

use serde_json::Value;
use tauri::{AppHandle, Emitter, State};

use crate::{
    knowledge_index::{
        advisor_source_id,
        canonical_store::{
            delete_documents_by_ids, load_document_rows, load_visual_retry_gates, replace_documents,
        },
        catalog::{replace_catalog, KnowledgeCatalogSummary},
        citation_anchors::{
            build_anchors_for_blocks, delete_anchors_for_documents, replace_anchors,
            replace_anchors_for_source, upsert_anchors_for_documents,
        },
        document_blocks::{
            block_records_from_document, build_blocks_for_source_with_cache_policy_and_visual_seen,
            canonical_needs_visual_backfill_for_config, is_visual_candidate_path,
            rebuild_search_index_from_blocks, replace_blocks, replace_blocks_for_source,
            resolve_visual_index_config, upsert_blocks_for_documents,
            visual_backfill_candidate_unit_ids, visual_document_blocks_missing,
            visual_document_ids_missing_blocks, CanonicalCachePolicy,
        },
        fingerprint::fingerprint_file,
        mark_indexed_now,
    },
    now_i64, now_iso, workspace_root, AppState, DocumentKnowledgeSourceRecord, KnowledgeNoteRecord,
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
        author_id: item.author_id,
        author_url: item.author_url,
        site_name: item.site_name,
        source_url: item.source_url,
        folder_path: item.folder_path.clone(),
        root_path: item.folder_path,
        cover_url: item.cover,
        thumbnail_url: None,
        preview_text: preview.clone(),
        scope: "workspace-shared".to_string(),
        owner_type: Some("redbook-note".to_string()),
        owner_id: Some(item.id.clone()),
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
        visual_search_summary: None,
        visual_search_path: None,
        visual_search_page: None,
        visual_search_unit_id: None,
        visual_search_evidence_refs: Vec::new(),
        visual_search_thumbnail_path: None,
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
        author_id: None,
        author_url: None,
        site_name: None,
        source_url: Some(item.video_url.clone()),
        folder_path: item.folder_path.clone(),
        root_path: item.folder_path,
        cover_url: None,
        thumbnail_url: Some(item.thumbnail_url),
        preview_text: preview.clone(),
        scope: "workspace-shared".to_string(),
        owner_type: Some("youtube-video".to_string()),
        owner_id: Some(item.id.clone()),
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
        visual_search_summary: None,
        visual_search_path: None,
        visual_search_page: None,
        visual_search_unit_id: None,
        visual_search_evidence_refs: Vec::new(),
        visual_search_thumbnail_path: None,
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
        author_id: None,
        author_url: None,
        site_name: None,
        source_url: None,
        folder_path: None,
        root_path: Some(item.root_path),
        cover_url: None,
        thumbnail_url: None,
        preview_text: preview.clone(),
        scope: "workspace-shared".to_string(),
        owner_type: Some("document-source".to_string()),
        owner_id: Some(item.id.clone()),
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
        visual_search_summary: None,
        visual_search_path: None,
        visual_search_page: None,
        visual_search_unit_id: None,
        visual_search_evidence_refs: Vec::new(),
        visual_search_thumbnail_path: None,
    }
}

fn local_visual_path(value: &str) -> Option<PathBuf> {
    crate::resolve_local_path(value)
        .filter(|path| path.exists() && path.is_file() && is_visual_candidate_path(path))
}

fn note_visual_paths(note: &KnowledgeNoteRecord) -> Vec<PathBuf> {
    let mut seen = HashSet::<PathBuf>::new();
    let mut paths = Vec::new();
    for source in note.images.iter().chain(note.cover.iter()) {
        let Some(path) = local_visual_path(source) else {
            continue;
        };
        if seen.insert(path.clone()) {
            paths.push(path);
        }
    }
    paths
}

fn video_visual_paths(video: &YoutubeVideoRecord) -> Vec<PathBuf> {
    if let Some(path) = local_visual_path(&video.thumbnail_url) {
        return vec![path];
    }
    video
        .folder_path
        .as_deref()
        .map(PathBuf::from)
        .map(|folder| folder.join("thumbnail.jpg"))
        .filter(|path| path.is_file())
        .into_iter()
        .collect()
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
    rebuild_catalog_with_cache_policy(
        app,
        state,
        CanonicalCachePolicy::RefreshIncompleteVisualIndex,
    )
}

pub(crate) fn refresh_catalog_summaries(
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
    Ok(())
}

pub(crate) fn rebuild_catalog_reusing_unchanged_canonical(
    app: &AppHandle,
    state: &State<'_, AppState>,
) -> Result<(), String> {
    rebuild_catalog_with_cache_policy(app, state, CanonicalCachePolicy::ReuseUnchangedFingerprint)
}

pub(crate) fn backfill_incomplete_visual_index(
    app: &AppHandle,
    state: &State<'_, AppState>,
) -> Result<(), String> {
    let repaired_from_canonical = repair_visual_blocks_from_canonical(app, state)?;
    if repaired_from_canonical && !visual_maintenance_needed(state)? {
        return Ok(());
    }
    if !visual_maintenance_needed(state)? {
        return Ok(());
    }
    backfill_visual_index_incrementally(app, state)
}

fn backfill_visual_index_incrementally(
    app: &AppHandle,
    state: &State<'_, AppState>,
) -> Result<(), String> {
    let knowledge_root = workspace_root(state)?.join("knowledge");
    let cache_policy = CanonicalCachePolicy::RefreshIncompleteVisualIndex;
    let mut visual_seen_paths = HashSet::<String>::new();
    let mut touched_blocks = 0usize;
    let mut processed_units = 0usize;
    let total_units = visual_backfill_progress_units(state, &knowledge_root)?;

    for note in crate::load_knowledge_notes_from_fs(&knowledge_root) {
        let note_paths = note_visual_paths(&note);
        let summary = summarize_note(note);
        for path in note_paths {
            let indexed = build_blocks_for_source_with_cache_policy_and_visual_seen(
                state,
                &summary.item_id,
                &summary.title,
                &path,
                &summary.updated_at,
                cache_policy,
                &mut visual_seen_paths,
            )?;
            touched_blocks += indexed.blocks.len();
            emit_visual_index_progress(app, &indexed.canonical_rows);
            processed_units += 1;
            update_rebuild_progress(state, processed_units, total_units)?;
        }
    }
    for video in crate::load_youtube_videos_from_fs(&knowledge_root) {
        let video_paths = video_visual_paths(&video);
        let summary = summarize_video(video);
        for path in video_paths {
            let indexed = build_blocks_for_source_with_cache_policy_and_visual_seen(
                state,
                &summary.item_id,
                &summary.title,
                &path,
                &summary.updated_at,
                cache_policy,
                &mut visual_seen_paths,
            )?;
            touched_blocks += indexed.blocks.len();
            emit_visual_index_progress(app, &indexed.canonical_rows);
            processed_units += 1;
            update_rebuild_progress(state, processed_units, total_units)?;
        }
    }
    for source in crate::load_document_sources_from_fs(&knowledge_root) {
        let root_path = PathBuf::from(&source.root_path);
        if !root_path.exists() {
            continue;
        }
        let indexed = build_blocks_for_source_with_cache_policy_and_visual_seen(
            state,
            &source.id,
            &source.name,
            &root_path,
            &source.updated_at,
            cache_policy,
            &mut visual_seen_paths,
        )?;
        touched_blocks += indexed.blocks.len();
        emit_visual_index_progress(app, &indexed.canonical_rows);
        processed_units += 1;
        update_rebuild_progress(state, processed_units, total_units)?;
    }
    let advisors = crate::with_store(state, |store| Ok(store.advisors.clone()))?;
    for advisor in advisors {
        let root_path = crate::advisor_knowledge_dir(state, &advisor.id)?;
        if !root_path.exists() {
            continue;
        }
        let indexed = build_blocks_for_source_with_cache_policy_and_visual_seen(
            state,
            &advisor_source_id(&advisor.id),
            &advisor.name,
            &root_path,
            &now_iso(),
            cache_policy,
            &mut visual_seen_paths,
        )?;
        touched_blocks += indexed.blocks.len();
        emit_visual_index_progress(app, &indexed.canonical_rows);
        processed_units += 1;
        update_rebuild_progress(state, processed_units, total_units)?;
    }

    if touched_blocks > 0 {
        rebuild_search_index_from_blocks(state)?;
        mark_indexed_now(state)?;
        let _ = app.emit("knowledge:catalog-updated", Value::String(now_iso()));
        let _ = app.emit("knowledge:changed", serde_json::json!({ "at": now_iso() }));
    }
    Ok(())
}

fn visual_backfill_progress_units(
    state: &State<'_, AppState>,
    knowledge_root: &Path,
) -> Result<usize, String> {
    let note_units = crate::load_knowledge_notes_from_fs(knowledge_root)
        .iter()
        .map(note_visual_paths)
        .map(|paths| paths.len())
        .sum::<usize>();
    let video_units = crate::load_youtube_videos_from_fs(knowledge_root)
        .iter()
        .map(video_visual_paths)
        .map(|paths| paths.len())
        .sum::<usize>();
    let document_units = crate::load_document_sources_from_fs(knowledge_root)
        .iter()
        .filter(|source| PathBuf::from(&source.root_path).exists())
        .count();
    let advisor_ids = crate::with_store(state, |store| {
        Ok(store
            .advisors
            .iter()
            .map(|advisor| advisor.id.clone())
            .collect::<Vec<_>>())
    })?;
    let advisor_units = advisor_ids
        .iter()
        .filter(|advisor_id| {
            crate::advisor_knowledge_dir(state, advisor_id)
                .map(|path| path.exists())
                .unwrap_or(false)
        })
        .count();
    Ok(note_units + video_units + document_units + advisor_units)
}

fn update_rebuild_progress(
    state: &State<'_, AppState>,
    processed_units: usize,
    total_units: usize,
) -> Result<(), String> {
    if total_units == 0 {
        return Ok(());
    }
    let progress = 0.05 + 0.9 * (processed_units.min(total_units) as f64 / total_units as f64);
    let mut runtime = state
        .knowledge_index_state
        .lock()
        .map_err(|_| "knowledge index state lock 已损坏".to_string())?;
    runtime.rebuild_progress = Some(progress.clamp(0.05, 0.95));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn youtube_visual_paths_falls_back_to_local_thumbnail() {
        let root = std::env::temp_dir().join(format!("redbox-youtube-thumbnail-{}", now_i64()));
        std::fs::create_dir_all(&root).expect("fixture directory should be created");
        let thumbnail = root.join("thumbnail.jpg");
        std::fs::write(&thumbnail, b"jpg").expect("thumbnail fixture should be written");

        let video = YoutubeVideoRecord {
            id: "youtube_test".to_string(),
            video_id: "test".to_string(),
            video_url: "https://youtube.com/watch?v=test".to_string(),
            title: "Test".to_string(),
            original_title: None,
            description: String::new(),
            summary: None,
            thumbnail_url: "https://i.ytimg.com/vi/test/maxresdefault.jpg".to_string(),
            has_subtitle: false,
            subtitle_content: None,
            subtitle_error: None,
            status: None,
            created_at: "2026-05-03T00:00:00Z".to_string(),
            folder_path: Some(root.display().to_string()),
        };

        assert_eq!(video_visual_paths(&video), vec![thumbnail]);
        let _ = std::fs::remove_dir_all(root);
    }
}

fn repair_visual_blocks_from_canonical(
    app: &AppHandle,
    state: &State<'_, AppState>,
) -> Result<bool, String> {
    let rows = load_document_rows(state, None)?;
    let visual_rows = rows
        .into_iter()
        .filter(|row| row.canonical_json.contains("\"visualManifest\""))
        .collect::<Vec<_>>();
    if visual_rows.is_empty() {
        return Ok(false);
    }

    let stale_document_ids = visual_rows
        .iter()
        .filter(|row| !Path::new(&row.absolute_path).is_file())
        .map(|row| row.document_id.clone())
        .collect::<Vec<_>>();
    if !stale_document_ids.is_empty() {
        delete_anchors_for_documents(state, &stale_document_ids)?;
        crate::knowledge_index::document_blocks::delete_blocks_for_documents(
            state,
            &stale_document_ids,
        )?;
        delete_documents_by_ids(state, &stale_document_ids)?;
        crate::append_debug_trace_global(format!(
            "[visual-index] cleaned_stale_documents count={}",
            stale_document_ids.len()
        ));
    }

    let stale_set = stale_document_ids.into_iter().collect::<HashSet<_>>();
    let missing_document_ids = visual_document_ids_missing_blocks(state)?
        .into_iter()
        .collect::<HashSet<_>>();
    if missing_document_ids.is_empty() {
        if stale_set.is_empty() {
            return Ok(false);
        }
        mark_indexed_now(state)?;
        let _ = app.emit("knowledge:catalog-updated", Value::String(now_iso()));
        let _ = app.emit("knowledge:changed", serde_json::json!({ "at": now_iso() }));
        return Ok(true);
    }

    let mut blocks = Vec::new();
    for row in visual_rows {
        if stale_set.contains(&row.document_id) || !missing_document_ids.contains(&row.document_id)
        {
            continue;
        }
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

    if blocks.is_empty() {
        return Ok(!stale_set.is_empty());
    }

    upsert_blocks_for_documents(state, &blocks)?;
    let anchors = build_anchors_for_blocks(&blocks);
    upsert_anchors_for_documents(state, &anchors)?;
    mark_indexed_now(state)?;
    crate::append_debug_trace_global(format!(
        "[visual-index] repaired_blocks_from_manifest documents={} blocks={}",
        missing_document_ids.len(),
        blocks.len()
    ));
    let _ = app.emit(
        "knowledge:file-index-updated",
        serde_json::json!({
            "at": now_iso(),
            "kind": "visual_index_blocks",
            "updated": blocks.len()
        }),
    );
    let _ = app.emit("knowledge:catalog-updated", Value::String(now_iso()));
    let _ = app.emit("knowledge:changed", serde_json::json!({ "at": now_iso() }));
    Ok(true)
}

pub(crate) fn visual_maintenance_needed(state: &State<'_, AppState>) -> Result<bool, String> {
    if visual_backfill_needed(state)? {
        return Ok(true);
    }
    if visual_source_documents_missing(state)? {
        return Ok(true);
    }
    if visual_document_blocks_missing(state)? {
        return Ok(true);
    }
    visual_discovery_needed(state)
}

fn visual_source_documents_missing(state: &State<'_, AppState>) -> Result<bool, String> {
    for row in load_document_rows(state, None)? {
        if row.canonical_json.contains("\"visualManifest\"")
            && !Path::new(&row.absolute_path).is_file()
        {
            return Ok(true);
        }
    }
    Ok(false)
}

pub(crate) fn visual_backfill_needed(state: &State<'_, AppState>) -> Result<bool, String> {
    let visual_config = resolve_visual_index_config(state)?;
    if !visual_config.has_callable_model() {
        return Ok(false);
    }
    let retry_gates = load_visual_retry_gates(state)?;
    let now_ms = now_i64();
    for row in load_document_rows(state, None)? {
        let canonical: crate::document_parse::CanonicalDocument =
            serde_json::from_str(&row.canonical_json).map_err(|error| error.to_string())?;
        if canonical_needs_visual_backfill_for_config(&canonical, &visual_config)
            && !visual_backfill_deferred_by_retry_gate(
                &canonical,
                &visual_config,
                &retry_gates,
                now_ms,
            )
        {
            return Ok(true);
        }
    }
    Ok(false)
}

fn visual_discovery_needed(state: &State<'_, AppState>) -> Result<bool, String> {
    let visual_config = resolve_visual_index_config(state)?;
    if !visual_config.has_callable_model() {
        return Ok(false);
    }
    let indexed_paths = load_document_rows(state, None)?
        .into_iter()
        .map(|row| row.absolute_path)
        .collect::<HashSet<_>>();
    visual_candidates_missing_from_index(state, &indexed_paths)
}

fn visual_candidates_missing_from_index(
    state: &State<'_, AppState>,
    indexed_paths: &HashSet<String>,
) -> Result<bool, String> {
    let knowledge_root = workspace_root(state)?.join("knowledge");
    for source in crate::load_document_sources_from_fs(&knowledge_root) {
        let root_path = PathBuf::from(&source.root_path);
        if visual_candidate_missing_under(&root_path, indexed_paths)? {
            return Ok(true);
        }
    }
    let advisors = crate::with_store(state, |store| Ok(store.advisors.clone()))?;
    for advisor in advisors {
        let root_path = crate::advisor_knowledge_dir(state, &advisor.id)?;
        if visual_candidate_missing_under(&root_path, indexed_paths)? {
            return Ok(true);
        }
    }
    for root in [
        knowledge_root.join("redbook"),
        knowledge_root.join("youtube"),
    ] {
        if visual_candidate_missing_under(&root, indexed_paths)? {
            return Ok(true);
        }
    }
    Ok(false)
}

fn visual_candidate_missing_under(
    root: &Path,
    indexed_paths: &HashSet<String>,
) -> Result<bool, String> {
    if !root.exists() {
        return Ok(false);
    }
    if root.is_file() {
        return Ok(is_missing_visual_candidate(root, indexed_paths));
    }
    let entries = match std::fs::read_dir(root) {
        Ok(entries) => entries,
        Err(error) => return Err(error.to_string()),
    };
    for entry in entries {
        let path = entry.map_err(|error| error.to_string())?.path();
        if path.is_dir() {
            if visual_candidate_missing_under(&path, indexed_paths)? {
                return Ok(true);
            }
        } else if path.is_file() && is_missing_visual_candidate(&path, indexed_paths) {
            return Ok(true);
        }
    }
    Ok(false)
}

fn is_missing_visual_candidate(path: &Path, indexed_paths: &HashSet<String>) -> bool {
    is_visual_candidate_path(path) && !indexed_paths.contains(&path.display().to_string())
}

fn visual_backfill_deferred_by_retry_gate(
    canonical: &crate::document_parse::CanonicalDocument,
    visual_config: &crate::document_parse::VisualIndexConfig,
    retry_gates: &std::collections::HashMap<
        String,
        crate::knowledge_index::canonical_store::VisualRetryGate,
    >,
    now_ms: i64,
) -> bool {
    let Some(unit_ids) = visual_backfill_candidate_unit_ids(canonical, Some(visual_config)) else {
        return false;
    };
    if unit_ids.is_empty() {
        return false;
    }
    let current_signature = visual_config.config_signature();
    unit_ids.iter().all(|unit_id| {
        let Some(gate) = retry_gates.get(unit_id) else {
            return false;
        };
        if gate.status != "failed" {
            return false;
        }
        if gate.config_signature.as_deref() != Some(current_signature.as_str()) {
            return false;
        }
        gate.next_retry_at
            .as_deref()
            .and_then(|value| value.parse::<i64>().ok())
            .is_some_and(|retry_at| retry_at > now_ms)
    })
}

fn emit_visual_index_progress(
    app: &AppHandle,
    rows: &[crate::knowledge_index::canonical_store::CanonicalDocumentRow],
) {
    let updated = rows
        .iter()
        .filter(|row| row.canonical_json.contains("\"visualManifest\""))
        .count();
    if updated == 0 {
        return;
    }
    let _ = app.emit(
        "knowledge:file-index-updated",
        serde_json::json!({
            "at": now_iso(),
            "kind": "visual_index",
            "updated": updated
        }),
    );
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
    let mut visual_seen_paths = HashSet::<String>::new();

    for note in crate::load_knowledge_notes_from_fs(&knowledge_root) {
        let note_visual_paths = note_visual_paths(&note);
        let summary = summarize_note(note);
        for path in note_visual_paths {
            let indexed = build_blocks_for_source_with_cache_policy_and_visual_seen(
                state,
                &summary.item_id,
                &summary.title,
                &path,
                &summary.updated_at,
                cache_policy,
                &mut visual_seen_paths,
            )?;
            emit_visual_index_progress(app, &indexed.canonical_rows);
            anchors.extend(build_anchors_for_blocks(&indexed.blocks));
            blocks.extend(indexed.blocks);
            canonical_rows.extend(indexed.canonical_rows);
        }
        files.extend(build_rows_for_note(&summary)?);
        items.push(summary);
    }
    for video in crate::load_youtube_videos_from_fs(&knowledge_root) {
        let video_visual_paths = video_visual_paths(&video);
        let summary = summarize_video(video);
        for path in video_visual_paths {
            let indexed = build_blocks_for_source_with_cache_policy_and_visual_seen(
                state,
                &summary.item_id,
                &summary.title,
                &path,
                &summary.updated_at,
                cache_policy,
                &mut visual_seen_paths,
            )?;
            emit_visual_index_progress(app, &indexed.canonical_rows);
            anchors.extend(build_anchors_for_blocks(&indexed.blocks));
            blocks.extend(indexed.blocks);
            canonical_rows.extend(indexed.canonical_rows);
        }
        files.extend(build_rows_for_video(&summary)?);
        items.push(summary);
    }
    for source in crate::load_document_sources_from_fs(&knowledge_root) {
        let root_path = PathBuf::from(&source.root_path);
        if root_path.exists() {
            let indexed = build_blocks_for_source_with_cache_policy_and_visual_seen(
                state,
                &source.id,
                &source.name,
                &root_path,
                &source.updated_at,
                cache_policy,
                &mut visual_seen_paths,
            )?;
            emit_visual_index_progress(app, &indexed.canonical_rows);
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
        let indexed = build_blocks_for_source_with_cache_policy_and_visual_seen(
            state,
            &advisor_source_id(&advisor.id),
            &advisor.name,
            &root_path,
            &now_iso(),
            cache_policy,
            &mut visual_seen_paths,
        )?;
        emit_visual_index_progress(app, &indexed.canonical_rows);
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
