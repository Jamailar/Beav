use crate::persistence::{
    apply_knowledge_hydration_snapshot, ensure_store_hydrated_for_media,
    load_knowledge_hydration_snapshot, with_store, with_store_mut,
};
use crate::workspace_loaders::read_json_file;
use crate::*;
use serde::Deserialize;
use serde_json::{Value, json};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, State};
use url::Url;

const DEFAULT_KNOWLEDGE_API_BODY_LIMIT: usize = 16 * 1_024 * 1_024;
const DEFAULT_KNOWLEDGE_BATCH_LIMIT: usize = 64;

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub(crate) struct KnowledgeSourceInput {
    pub app_id: Option<String>,
    pub plugin_id: Option<String>,
    pub external_id: Option<String>,
    pub source_domain: Option<String>,
    pub source_link: Option<String>,
    pub source_url: Option<String>,
    pub captured_at: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub(crate) struct KnowledgeEntryStatsInput {
    pub likes: Option<i64>,
    pub collects: Option<i64>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub(crate) struct KnowledgeEntryContentInput {
    pub title: String,
    pub author: Option<String>,
    pub text: Option<String>,
    pub excerpt: Option<String>,
    pub html: Option<String>,
    pub description: Option<String>,
    pub summary: Option<String>,
    pub site_name: Option<String>,
    pub transcript: Option<String>,
    pub tags: Vec<String>,
    pub stats: Option<KnowledgeEntryStatsInput>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub(crate) struct KnowledgeEntryAssetsInput {
    pub cover_url: Option<String>,
    pub image_urls: Vec<String>,
    pub video_url: Option<String>,
    pub thumbnail_url: Option<String>,
}

fn default_allow_update() -> bool {
    true
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct KnowledgeIngestOptionsInput {
    #[serde(default)]
    pub dedupe_key: Option<String>,
    #[serde(default = "default_allow_update")]
    pub allow_update: bool,
    #[serde(default)]
    pub summarize: bool,
    #[serde(default)]
    pub transcribe: bool,
}

impl Default for KnowledgeIngestOptionsInput {
    fn default() -> Self {
        Self {
            dedupe_key: None,
            allow_update: true,
            summarize: false,
            transcribe: false,
        }
    }
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub(crate) struct KnowledgeEntryIngestRequest {
    pub space_id: Option<String>,
    pub kind: String,
    pub source: KnowledgeSourceInput,
    pub content: KnowledgeEntryContentInput,
    pub assets: KnowledgeEntryAssetsInput,
    pub options: KnowledgeIngestOptionsInput,
}

fn default_copy_into_workspace() -> bool {
    true
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct KnowledgeDocumentSourceOptionsInput {
    #[serde(default = "default_copy_into_workspace")]
    pub copy_into_workspace: bool,
    #[serde(default = "default_allow_update")]
    pub allow_update: bool,
}

impl Default for KnowledgeDocumentSourceOptionsInput {
    fn default() -> Self {
        Self {
            copy_into_workspace: true,
            allow_update: true,
        }
    }
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub(crate) struct KnowledgeDocumentSourceIngestRequest {
    pub space_id: Option<String>,
    pub kind: String,
    pub source: KnowledgeSourceInput,
    pub name: Option<String>,
    pub paths: Vec<String>,
    pub root_path: Option<String>,
    pub options: KnowledgeDocumentSourceOptionsInput,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub(crate) struct KnowledgeBatchIngestRequest {
    pub entries: Vec<KnowledgeEntryIngestRequest>,
    pub document_sources: Vec<KnowledgeDocumentSourceIngestRequest>,
    pub media_assets: Vec<KnowledgeMediaAssetIngestRequest>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub(crate) struct KnowledgeMediaAssetItemInput {
    pub title: Option<String>,
    pub source: String,
    pub mime_type: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub(crate) struct KnowledgeMediaAssetIngestRequest {
    pub space_id: Option<String>,
    pub source: KnowledgeSourceInput,
    pub items: Vec<KnowledgeMediaAssetItemInput>,
}

fn normalize_string(value: Option<String>) -> Option<String> {
    value
        .map(|item| item.trim().to_string())
        .filter(|item| !item.is_empty())
}

fn normalize_vec(values: Vec<String>) -> Vec<String> {
    values
        .into_iter()
        .map(|item| item.trim().to_string())
        .filter(|item| !item.is_empty())
        .collect()
}

fn source_link_from_input(source: &KnowledgeSourceInput) -> Option<String> {
    normalize_string(source.source_link.clone())
        .or_else(|| normalize_string(source.source_url.clone()))
}

fn domain_from_link(raw: &str) -> Option<String> {
    Url::parse(raw)
        .ok()
        .and_then(|parsed| parsed.host_str().map(|value| value.to_ascii_lowercase()))
        .filter(|value| !value.is_empty())
}

fn source_domain_from_input(source: &KnowledgeSourceInput) -> Option<String> {
    normalize_string(source.source_domain.clone())
        .map(|value| value.to_ascii_lowercase())
        .or_else(|| {
            source_link_from_input(source)
                .as_deref()
                .and_then(domain_from_link)
        })
}

fn ensure_supported_space(
    state: &State<'_, AppState>,
    requested_space_id: Option<&str>,
) -> Result<String, String> {
    let active_space_id = with_store(state, |store| Ok(store.active_space_id.clone()))?;
    if let Some(space_id) = requested_space_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        if space_id != active_space_id {
            return Err(format!(
                "当前仅支持写入活动空间；请求 spaceId={}，活动空间={}",
                space_id, active_space_id
            ));
        }
    }
    Ok(active_space_id)
}

fn knowledge_redbook_root(state: &State<'_, AppState>) -> Result<PathBuf, String> {
    let root = knowledge_root(state)?.join("redbook");
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    Ok(root)
}

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

fn redbook_entry_dir(state: &State<'_, AppState>, entry_id: &str) -> Result<PathBuf, String> {
    let root = knowledge_redbook_root(state)?.join(entry_id);
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    Ok(root)
}

fn youtube_entry_id(seed: &str) -> String {
    let slug = slug_from_relative_path(seed);
    if slug.is_empty() {
        make_id("youtube")
    } else {
        format!("youtube-{slug}")
    }
}

fn note_entry_id(seed: &str) -> String {
    let slug = slug_from_relative_path(seed);
    if slug.is_empty() {
        make_id("knowledge")
    } else {
        format!("knowledge-{slug}")
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
    let snapshot = load_knowledge_hydration_snapshot(&root);
    with_store_mut(state, |store| {
        apply_knowledge_hydration_snapshot(store, snapshot);
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
        crate::knowledge_index::jobs::schedule_rebuild(app, "knowledge-mutation");
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

fn metadata_string(path: &Path, key: &str) -> Option<String> {
    read_json_file(path).and_then(|meta| {
        meta.get(key)
            .and_then(|value| value.as_str())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToString::to_string)
    })
}

fn find_redbook_entry_id_by_meta_field(
    state: &State<'_, AppState>,
    field_name: &str,
    expected: &str,
) -> Result<Option<String>, String> {
    let expected = expected.trim();
    if expected.is_empty() {
        return Ok(None);
    }
    let root = knowledge_redbook_root(state)?;
    let entries = fs::read_dir(&root).map_err(|error| error.to_string())?;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let meta_path = path.join("meta.json");
        let Some(value) = metadata_string(&meta_path, field_name) else {
            continue;
        };
        if value == expected {
            let entry_id = metadata_string(&meta_path, "id")
                .unwrap_or_else(|| entry.file_name().to_string_lossy().to_string());
            return Ok(Some(entry_id));
        }
    }
    Ok(None)
}

fn note_content_markdown(content: &KnowledgeEntryContentInput) -> Option<String> {
    normalize_string(content.text.clone())
        .or_else(|| normalize_string(content.description.clone()))
        .or_else(|| normalize_string(content.excerpt.clone()))
}

fn normalize_entry_kind(kind: &str) -> String {
    match kind.trim() {
        "text" => "text-note".to_string(),
        other => other.to_string(),
    }
}

fn note_meta_type(kind: &str) -> String {
    if kind == "text-note" {
        "text".to_string()
    } else {
        kind.to_string()
    }
}

fn truncated_plain_text(value: &str, max_chars: usize) -> String {
    let trimmed = value.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut chars = trimmed.chars();
    let compact = chars.by_ref().take(max_chars).collect::<String>();
    if chars.next().is_some() {
        format!("{compact}...")
    } else {
        compact
    }
}

fn title_from_source_url(source_url: &str) -> Option<String> {
    let parsed = Url::parse(source_url).ok()?;
    let last_segment = parsed
        .path_segments()
        .and_then(|segments| segments.filter(|segment| !segment.is_empty()).last())
        .unwrap_or_default();
    let stem = Path::new(last_segment)
        .file_stem()
        .and_then(|value| value.to_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string);
    stem.or_else(|| parsed.host_str().map(ToString::to_string))
}

fn derive_note_title(request: &KnowledgeEntryIngestRequest, normalized_kind: &str) -> String {
    if let Some(title) = normalize_string(Some(request.content.title.clone())) {
        return title;
    }
    for candidate in [
        request.content.excerpt.clone(),
        request.content.text.clone(),
        request.content.description.clone(),
        request.content.summary.clone(),
        request.content.transcript.clone(),
    ] {
        if let Some(value) = normalize_string(candidate) {
            return truncated_plain_text(&value, 48);
        }
    }
    if let Some(source_url) = source_link_from_input(&request.source) {
        if let Some(title) = title_from_source_url(&source_url) {
            return title;
        }
    }
    if normalized_kind == "text-note" {
        "未命名文本摘录".to_string()
    } else {
        "未命名知识内容".to_string()
    }
}

fn derive_note_author(request: &KnowledgeEntryIngestRequest, normalized_kind: &str) -> String {
    normalize_string(request.content.author.clone()).unwrap_or_else(|| {
        if normalized_kind == "text-note" {
            "文本摘录".to_string()
        } else if source_link_from_input(&request.source).is_some() {
            "原文链接".to_string()
        } else {
            "手动导入".to_string()
        }
    })
}

fn resolve_note_seed(request: &KnowledgeEntryIngestRequest) -> String {
    normalize_string(request.source.external_id.clone())
        .or_else(|| normalize_string(request.options.dedupe_key.clone()))
        .or_else(|| source_link_from_input(&request.source))
        .or_else(|| normalize_string(Some(request.content.title.clone())))
        .or_else(|| normalize_string(request.content.excerpt.clone()))
        .or_else(|| normalize_string(request.content.text.clone()))
        .unwrap_or_else(|| make_id("knowledge"))
}

fn find_existing_note_entry_id(
    state: &State<'_, AppState>,
    request: &KnowledgeEntryIngestRequest,
) -> Result<Option<String>, String> {
    if let Some(dedupe_key) = normalize_string(request.options.dedupe_key.clone()) {
        if let Some(entry_id) =
            find_redbook_entry_id_by_meta_field(state, "dedupeKey", &dedupe_key)?
        {
            return Ok(Some(entry_id));
        }
    }
    if let Some(external_id) = normalize_string(request.source.external_id.clone()) {
        if let Some(entry_id) =
            find_redbook_entry_id_by_meta_field(state, "externalId", &external_id)?
        {
            return Ok(Some(entry_id));
        }
    }
    if let Some(source_url) = source_link_from_input(&request.source) {
        let existing = with_store(state, |store| {
            Ok(store
                .knowledge_notes
                .iter()
                .find(|item| item.source_url.as_deref() == Some(source_url.as_str()))
                .map(|item| item.id.clone()))
        })?;
        if existing.is_some() {
            return Ok(existing);
        }
        if let Some(entry_id) =
            find_redbook_entry_id_by_meta_field(state, "sourceUrl", &source_url)?
        {
            return Ok(Some(entry_id));
        }
    }
    Ok(None)
}

fn find_existing_youtube_video(
    state: &State<'_, AppState>,
    request: &KnowledgeEntryIngestRequest,
) -> Result<Option<YoutubeVideoRecord>, String> {
    let external_id = normalize_string(request.source.external_id.clone());
    let source_url = normalize_string(request.source.source_url.clone());
    with_store(state, |store| {
        Ok(store
            .youtube_videos
            .iter()
            .find(|item| {
                external_id
                    .as_deref()
                    .is_some_and(|video_id| item.video_id == video_id)
                    || source_url
                        .as_deref()
                        .is_some_and(|video_url| item.video_url == video_url)
            })
            .cloned())
    })
}

fn ingest_youtube_entry(
    app: Option<&AppHandle>,
    state: &State<'_, AppState>,
    request: &KnowledgeEntryIngestRequest,
) -> Result<Value, String> {
    ensure_supported_space(state, request.space_id.as_deref())?;
    let _ = ensure_store_hydrated_for_knowledge(state);
    let existing = find_existing_youtube_video(state, request)?;
    if existing.is_some() && !request.options.allow_update {
        let existing = existing.unwrap();
        return Ok(json!({
            "success": true,
            "kind": "youtube-video",
            "duplicate": true,
            "updated": false,
            "entryId": existing.id,
        }));
    }

    let video_id = normalize_string(request.source.external_id.clone())
        .ok_or_else(|| "youtube-video 缺少 source.externalId / videoId".to_string())?;
    let video_url = source_link_from_input(&request.source)
        .ok_or_else(|| "youtube-video 缺少 source.sourceUrl / videoUrl".to_string())?;
    let source_domain = source_domain_from_input(&request.source);
    let title = normalize_string(Some(request.content.title.clone()))
        .ok_or_else(|| "youtube-video 缺少 content.title".to_string())?;
    let description = normalize_string(request.content.description.clone())
        .or_else(|| normalize_string(request.content.text.clone()))
        .unwrap_or_default();
    let entry_id = existing
        .as_ref()
        .map(|item| item.id.clone())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| youtube_entry_id(&video_id));
    let created_at = normalize_string(request.source.captured_at.clone())
        .or_else(|| existing.as_ref().map(|item| item.created_at.clone()))
        .unwrap_or_else(now_iso);
    let summary = normalize_string(request.content.summary.clone())
        .or_else(|| existing.as_ref().and_then(|item| item.summary.clone()))
        .unwrap_or_else(|| "RedBox captured this video for later migration work.".to_string());
    let subtitle_file = normalize_string(request.content.transcript.clone())
        .map(|_| "subtitle.txt".to_string())
        .or_else(|| {
            existing.as_ref().and_then(|item| {
                item.folder_path
                    .as_ref()
                    .and_then(|folder| {
                        read_json_file(Path::new(folder).join("meta.json").as_path())
                    })
                    .and_then(|meta| {
                        meta.get("subtitleFile")
                            .or_else(|| meta.get("subtitle_file"))
                            .and_then(|value| value.as_str())
                            .map(ToString::to_string)
                    })
            })
        });
    let entry_dir = youtube_entry_dir(state, &entry_id)?;
    if let Some(transcript) = normalize_string(request.content.transcript.clone()) {
        fs::write(entry_dir.join("subtitle.txt"), transcript).map_err(|error| error.to_string())?;
    }
    let meta = json!({
        "id": entry_id,
        "videoId": video_id,
        "videoUrl": video_url,
        "title": title,
        "originalTitle": title,
        "description": description,
        "summary": summary,
        "thumbnailUrl": normalize_string(request.assets.thumbnail_url.clone()).unwrap_or_default(),
        "hasSubtitle": subtitle_file.is_some(),
        "status": "completed",
        "createdAt": created_at,
        "subtitleFile": subtitle_file,
        "sourceDomain": source_domain,
        "sourceLink": video_url,
        "sourceAppId": normalize_string(request.source.app_id.clone()),
        "sourcePluginId": normalize_string(request.source.plugin_id.clone()),
        "dedupeKey": normalize_string(request.options.dedupe_key.clone()),
    });
    write_json_value(&entry_dir.join("meta.json"), &meta)?;
    refresh_knowledge_projection_and_emit(
        app,
        state,
        Some((
            "knowledge:new-youtube-video",
            json!({
                "noteId": entry_id,
                "title": request.content.title,
                "status": "completed",
            }),
        )),
    )?;
    Ok(json!({
        "success": true,
        "kind": "youtube-video",
        "duplicate": existing.is_some(),
        "updated": existing.is_some(),
        "entryId": entry_id,
        "requestedActions": {
            "summarize": request.options.summarize,
            "transcribe": request.options.transcribe,
        },
    }))
}

fn ingest_note_entry(
    app: Option<&AppHandle>,
    state: &State<'_, AppState>,
    request: &KnowledgeEntryIngestRequest,
) -> Result<Value, String> {
    ensure_supported_space(state, request.space_id.as_deref())?;
    let _ = ensure_store_hydrated_for_knowledge(state);
    let existing_entry_id = find_existing_note_entry_id(state, request)?;
    if existing_entry_id.is_some() && !request.options.allow_update {
        return Ok(json!({
            "success": true,
            "kind": request.kind,
            "duplicate": true,
            "updated": false,
            "entryId": existing_entry_id,
        }));
    }

    let normalized_kind = normalize_entry_kind(&request.kind);
    let title = derive_note_title(request, &normalized_kind);
    let source_link = source_link_from_input(&request.source);
    let source_domain = source_domain_from_input(&request.source);
    let entry_id = existing_entry_id
        .clone()
        .unwrap_or_else(|| note_entry_id(&resolve_note_seed(request)));
    let entry_dir = redbook_entry_dir(state, &entry_id)?;

    let markdown = note_content_markdown(&request.content);
    if let Some(markdown) = markdown.as_ref() {
        fs::write(entry_dir.join("content.md"), markdown).map_err(|error| error.to_string())?;
    }
    if let Some(html) = normalize_string(request.content.html.clone()) {
        fs::write(entry_dir.join("content.html"), html).map_err(|error| error.to_string())?;
    }
    if let Some(transcript) = normalize_string(request.content.transcript.clone()) {
        fs::write(entry_dir.join("transcript.md"), transcript)
            .map_err(|error| error.to_string())?;
    }

    let stats = request.content.stats.clone().unwrap_or_default();
    let images = normalize_vec(request.assets.image_urls.clone());
    let cover_url =
        normalize_string(request.assets.cover_url.clone()).or_else(|| images.first().cloned());
    let created_at = normalize_string(request.source.captured_at.clone()).unwrap_or_else(now_iso);
    let meta = json!({
        "id": entry_id,
        "type": note_meta_type(&normalized_kind),
        "captureKind": normalized_kind,
        "sourceDomain": source_domain.clone(),
        "sourceLink": source_link.clone(),
        "sourceUrl": source_link.clone(),
        "sourceAppId": normalize_string(request.source.app_id.clone()),
        "sourcePluginId": normalize_string(request.source.plugin_id.clone()),
        "externalId": normalize_string(request.source.external_id.clone()),
        "dedupeKey": normalize_string(request.options.dedupe_key.clone()),
        "title": title,
        "author": derive_note_author(request, &normalized_kind),
        "excerpt": normalize_string(request.content.excerpt.clone()),
        "description": normalize_string(request.content.description.clone()),
        "siteName": normalize_string(request.content.site_name.clone()),
        "tags": normalize_vec(request.content.tags.clone()),
        "images": images,
        "cover": cover_url,
        "videoUrl": normalize_string(request.assets.video_url.clone()),
        "video": normalize_string(request.assets.video_url.clone()),
        "htmlFile": if normalize_string(request.content.html.clone()).is_some() { Some("content.html") } else { None },
        "transcriptFile": if normalize_string(request.content.transcript.clone()).is_some() { Some("transcript.md") } else { None },
        "transcriptionStatus": if normalize_string(request.content.transcript.clone()).is_some() { Some("completed") } else { None },
        "stats": {
            "likes": stats.likes.unwrap_or(0),
            "collects": stats.collects
        },
        "createdAt": created_at,
        "updatedAt": now_iso(),
    });
    write_json_value(&entry_dir.join("meta.json"), &meta)?;
    refresh_knowledge_projection_and_emit(
        app,
        state,
        Some((
            "knowledge:note-updated",
            json!({
                "noteId": entry_id,
                "kind": normalized_kind,
                "hasTranscript": normalize_string(request.content.transcript.clone()).is_some(),
            }),
        )),
    )?;
    Ok(json!({
        "success": true,
        "kind": normalized_kind,
        "duplicate": existing_entry_id.is_some(),
        "updated": existing_entry_id.is_some(),
        "entryId": entry_id,
        "requestedActions": {
            "summarize": request.options.summarize,
            "transcribe": request.options.transcribe,
        },
    }))
}

fn relative_media_path_from_absolute(media_root: &Path, absolute_path: &Path) -> Option<String> {
    let normalized = normalize_legacy_workspace_path(absolute_path);
    normalized
        .strip_prefix(media_root)
        .ok()
        .map(|value| normalize_relative_path(value.to_string_lossy().as_ref()))
}

fn title_from_media_source(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.starts_with("data:") {
        return None;
    }
    if let Ok(parsed) = Url::parse(trimmed) {
        let last_segment = parsed
            .path_segments()
            .and_then(|segments| segments.filter(|segment| !segment.is_empty()).last())
            .unwrap_or_default();
        return Path::new(last_segment)
            .file_stem()
            .and_then(|value| value.to_str())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToString::to_string);
    }
    Path::new(trimmed)
        .file_stem()
        .and_then(|value| value.to_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn create_media_asset_record(
    media_root: &Path,
    asset_path: &Path,
    source: &KnowledgeSourceInput,
    item: &KnowledgeMediaAssetItemInput,
) -> Result<MediaAssetRecord, String> {
    let normalized = normalize_legacy_workspace_path(asset_path);
    let (guessed_mime_type, kind, _) = guess_mime_and_kind(&normalized);
    let requested_mime_type = normalize_string(item.mime_type.clone());
    let mime_type = requested_mime_type
        .clone()
        .filter(|value| value.starts_with("image/"))
        .unwrap_or_else(|| guessed_mime_type.clone());
    let is_image = kind == "image" || mime_type.starts_with("image/");
    if !is_image {
        return Err(format!(
            "media-assets 仅支持图片导入，当前文件不是图片: {}",
            normalized.display()
        ));
    }
    let relative_path = relative_media_path_from_absolute(media_root, &normalized)
        .ok_or_else(|| "素材路径不在 workspace media 目录内".to_string())?;
    let title =
        normalize_string(item.title.clone()).or_else(|| title_from_media_source(&item.source));
    let timestamp = now_iso();
    Ok(MediaAssetRecord {
        id: make_id("media"),
        source: "knowledge-api".to_string(),
        source_domain: source_domain_from_input(source),
        source_link: source_link_from_input(source),
        project_id: None,
        title,
        prompt: None,
        provider: None,
        provider_template: None,
        model: None,
        aspect_ratio: None,
        size: None,
        quality: None,
        mime_type: Some(mime_type),
        relative_path: Some(relative_path),
        bound_manuscript_path: None,
        created_at: timestamp.clone(),
        updated_at: timestamp,
        absolute_path: Some(normalized.display().to_string()),
        preview_url: Some(file_url_for_path(&normalized)),
        exists: true,
    })
}

pub(crate) fn ingest_media_assets(
    _app: Option<&AppHandle>,
    state: &State<'_, AppState>,
    request: &KnowledgeMediaAssetIngestRequest,
) -> Result<Value, String> {
    ensure_supported_space(state, request.space_id.as_deref())?;
    let _ = ensure_store_hydrated_for_media(state);
    if request.items.is_empty() {
        return Err("media-assets 至少需要一个 item".to_string());
    }
    if request.items.len() > DEFAULT_KNOWLEDGE_BATCH_LIMIT {
        return Err(format!(
            "单次 media-assets 最多支持 {} 项",
            DEFAULT_KNOWLEDGE_BATCH_LIMIT
        ));
    }

    let media_root = media_root(state)?;
    let imports_root = media_root.join("imports").join("knowledge-api");
    fs::create_dir_all(&imports_root).map_err(|error| error.to_string())?;

    let mut assets = Vec::new();
    for item in &request.items {
        let source = normalize_string(Some(item.source.clone()))
            .ok_or_else(|| "media-assets item 缺少 source".to_string())?;
        let materialized =
            if let Some(local_path) = resolve_local_path(&source).filter(|path| path.exists()) {
                let (_, copied) = copy_file_into_dir(&local_path, &imports_root)?;
                copied
            } else {
                materialize_image_source(&source, &imports_root)?
            };
        match create_media_asset_record(&media_root, &materialized, &request.source, item) {
            Ok(asset) => assets.push(asset),
            Err(error) => {
                if materialized.starts_with(&imports_root) {
                    let _ = fs::remove_file(&materialized);
                }
                return Err(error);
            }
        }
    }

    with_store_mut(state, |store| {
        for asset in &assets {
            store.media_assets.push(asset.clone());
        }
        Ok(())
    })?;
    crate::commands::library::persist_media_workspace_catalog(state)?;

    Ok(json!({
        "success": true,
        "kind": "media-assets",
        "imported": assets.len(),
        "assets": assets,
    }))
}

fn collect_document_paths(request: &KnowledgeDocumentSourceIngestRequest) -> Vec<PathBuf> {
    let mut paths = request
        .paths
        .iter()
        .filter_map(|item| normalize_string(Some(item.clone())).map(PathBuf::from))
        .collect::<Vec<_>>();
    if let Some(root_path) = normalize_string(request.root_path.clone()) {
        let root = PathBuf::from(root_path);
        if root.is_file() {
            paths.push(root);
        }
    }
    paths
}

pub(crate) fn ingest_entry(
    app: Option<&AppHandle>,
    state: &State<'_, AppState>,
    request: &KnowledgeEntryIngestRequest,
) -> Result<Value, String> {
    let normalized_kind = normalize_entry_kind(&request.kind);
    let kind = normalized_kind.as_str();
    if kind.is_empty() {
        return Err("knowledge entry kind 不能为空".to_string());
    }
    match kind {
        "youtube-video" => ingest_youtube_entry(app, state, request),
        "xhs-note" | "xhs-video" | "link-article" | "wechat-article" | "knowledge-note"
        | "webpage" | "article" | "text-note" => ingest_note_entry(app, state, request),
        other => Err(format!("暂不支持的 knowledge entry kind: {other}")),
    }
}

pub(crate) fn ingest_document_source(
    app: Option<&AppHandle>,
    state: &State<'_, AppState>,
    request: &KnowledgeDocumentSourceIngestRequest,
) -> Result<Value, String> {
    let app = app.ok_or_else(|| "document source ingestion 缺少 app handle".to_string())?;
    ensure_supported_space(state, request.space_id.as_deref())?;
    let kind = request.kind.trim();
    if kind.is_empty() {
        return Err("document source kind 不能为空".to_string());
    }
    let name = normalize_string(request.name.clone()).unwrap_or_else(|| match kind {
        "tracked-folder" => "Tracked Folder".to_string(),
        "obsidian-vault" => "Obsidian Vault".to_string(),
        _ => "Imported Files".to_string(),
    });
    match kind {
        "copied-file" => {
            if !request.options.copy_into_workspace {
                return Err("copied-file 当前必须 copyIntoWorkspace=true".to_string());
            }
            let files = collect_document_paths(request);
            if files.is_empty() {
                return Err("copied-file 需要至少一个有效文件路径".to_string());
            }
            let source_id = make_id("doc-source");
            let batch_root = imported_docs_root(state)?.join(&source_id);
            fs::create_dir_all(&batch_root).map_err(|error| error.to_string())?;
            for file in &files {
                let _ = copy_file_into_dir(file, &batch_root)?;
            }
            add_document_source(app, state, kind, &batch_root, &name, true)
        }
        "tracked-folder" | "obsidian-vault" => {
            let root = normalize_string(request.root_path.clone())
                .map(PathBuf::from)
                .or_else(|| {
                    request
                        .paths
                        .first()
                        .and_then(|path| normalize_string(Some(path.clone())).map(PathBuf::from))
                })
                .ok_or_else(|| format!("{kind} 需要 rootPath"))?;
            if !root.exists() || !root.is_dir() {
                return Err(format!("文档源目录不存在: {}", root.display()));
            }
            let response = add_document_source(app, state, kind, &root, &name, false)?;
            Ok(json!({
                "success": response.get("success").and_then(|value| value.as_bool()).unwrap_or(false),
                "source": response.get("source").cloned().unwrap_or(Value::Null),
                "requestedOptions": {
                    "allowUpdate": request.options.allow_update,
                    "copyIntoWorkspace": request.options.copy_into_workspace,
                },
            }))
        }
        other => Err(format!("暂不支持的 document source kind: {other}")),
    }
}

pub(crate) fn batch_ingest(
    app: Option<&AppHandle>,
    state: &State<'_, AppState>,
    request: &KnowledgeBatchIngestRequest,
) -> Result<Value, String> {
    let total = request.entries.len() + request.document_sources.len() + request.media_assets.len();
    if total == 0 {
        return Err("batch-ingest 不能为空".to_string());
    }
    if total > DEFAULT_KNOWLEDGE_BATCH_LIMIT {
        return Err(format!(
            "单次 batch-ingest 最多支持 {} 项",
            DEFAULT_KNOWLEDGE_BATCH_LIMIT
        ));
    }
    let mut results = Vec::new();
    for entry in &request.entries {
        results.push(json!({
            "type": "entry",
            "result": ingest_entry(app, state, entry)?,
        }));
    }
    for document_source in &request.document_sources {
        results.push(json!({
            "type": "document-source",
            "result": ingest_document_source(app, state, document_source)?,
        }));
    }
    for media_assets in &request.media_assets {
        results.push(json!({
            "type": "media-assets",
            "result": ingest_media_assets(app, state, media_assets)?,
        }));
    }
    Ok(json!({
        "success": true,
        "count": results.len(),
        "results": results,
    }))
}

pub(crate) fn knowledge_http_health(
    state: &State<'_, AppState>,
    body_limit_bytes: usize,
    batch_limit: usize,
) -> Result<Value, String> {
    let _ = ensure_store_hydrated_for_media(state);
    let page = crate::knowledge_index::catalog::list_page(state, None, 1, None, None, None)?;
    let snapshot = with_store(state, |store| {
        Ok(json!({
            "success": true,
            "counts": {
                "entries": page.kind_counts.get("redbook-note").and_then(|value| value.as_i64()).unwrap_or(0),
                "youtubeVideos": page.kind_counts.get("youtube-video").and_then(|value| value.as_i64()).unwrap_or(0),
                "documentSources": page.kind_counts.get("document-source").and_then(|value| value.as_i64()).unwrap_or(0),
                "mediaAssets": store.media_assets.len(),
            },
            "limits": {
                "bodyBytes": body_limit_bytes,
                "batchItems": batch_limit,
            },
            "routes": {
                "entries": "/api/knowledge/entries",
                "documentSources": "/api/knowledge/document-sources",
                "mediaAssets": "/api/knowledge/media-assets",
                "batchIngest": "/api/knowledge/batch-ingest",
            },
            "capabilities": {
                "sourceFields": ["sourceDomain", "sourceLink", "sourceUrl"],
                "entryKinds": [
                    "youtube-video",
                    "xhs-note",
                    "xhs-video",
                    "link-article",
                    "wechat-article",
                    "knowledge-note",
                    "webpage",
                    "article",
                    "text-note",
                ],
                "mediaAssetKinds": ["image"],
            },
            "spaceId": store.active_space_id,
        }))
    })?;
    Ok(snapshot)
}

pub(crate) fn knowledge_http_body_limit() -> usize {
    DEFAULT_KNOWLEDGE_API_BODY_LIMIT
}

pub(crate) fn knowledge_http_batch_limit() -> usize {
    DEFAULT_KNOWLEDGE_BATCH_LIMIT
}

pub(crate) fn save_youtube_note(
    app: &AppHandle,
    state: &State<'_, AppState>,
    input: &YoutubeSavePayload,
) -> Result<Value, String> {
    let request = KnowledgeEntryIngestRequest {
        space_id: None,
        kind: "youtube-video".to_string(),
        source: KnowledgeSourceInput {
            app_id: Some("redbox".to_string()),
            plugin_id: None,
            external_id: Some(input.video_id.clone()),
            source_domain: domain_from_link(&input.video_url),
            source_link: Some(input.video_url.clone()),
            source_url: Some(input.video_url.clone()),
            captured_at: None,
        },
        content: KnowledgeEntryContentInput {
            title: input.title.clone(),
            description: input.description.clone(),
            ..Default::default()
        },
        assets: KnowledgeEntryAssetsInput {
            thumbnail_url: input.thumbnail_url.clone(),
            ..Default::default()
        },
        options: KnowledgeIngestOptionsInput::default(),
    };
    let response = ingest_entry(Some(app), state, &request)?;
    Ok(json!({
        "success": response.get("success").and_then(|value| value.as_bool()).unwrap_or(false),
        "duplicate": response.get("duplicate").and_then(|value| value.as_bool()).unwrap_or(false),
        "migrated": response.get("duplicate").and_then(|value| value.as_bool()).unwrap_or(false),
        "noteId": response.get("entryId").cloned().unwrap_or(Value::Null),
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
    let request = KnowledgeDocumentSourceIngestRequest {
        space_id: None,
        kind: "copied-file".to_string(),
        source: KnowledgeSourceInput {
            app_id: Some("redbox".to_string()),
            ..Default::default()
        },
        name: Some(display_name.to_string()),
        paths: files
            .iter()
            .map(|path| path.display().to_string())
            .collect::<Vec<_>>(),
        root_path: None,
        options: KnowledgeDocumentSourceOptionsInput::default(),
    };
    ingest_document_source(Some(app), state, &request)
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
        return Ok(json!({ "success": true, "transcript": transcript }));
    }

    with_store_mut(state, |store| {
        let Some(target) = store
            .knowledge_notes
            .iter_mut()
            .find(|item| item.id == note_id)
        else {
            return Ok(());
        };
        target.transcript = Some(transcript.to_string());
        target.transcription_status = Some("completed".to_string());
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
