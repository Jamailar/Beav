use dirs::config_dir;
use serde_json::json;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::MutexGuard;
use std::time::Duration;
use tauri::State;

use crate::runtime::SkillRecord;
use crate::scheduler::sync_redclaw_job_definitions;
use crate::skills::builtin_skill_records;
use crate::store::{
    media as media_store, redclaw as redclaw_store, spaces as spaces_store,
    subjects as subjects_store,
};
use crate::workspace_loaders::{
    load_chat_rooms_from_fs, load_chatroom_messages_from_fs, load_memories_from_fs,
    load_memory_history_from_fs,
};
use crate::{
    active_space_workspace_root_from_store, app_brand_display_name, load_advisors_from_fs,
    load_cover_assets_from_fs, load_document_sources_from_fs, load_knowledge_authors_from_fs,
    load_knowledge_notes_from_fs, load_media_assets_from_fs, load_redclaw_state_from_fs,
    load_subject_categories_from_fs, load_subjects_from_fs, load_work_items_from_fs,
    load_youtube_videos_from_fs, now_iso, storage_safe_file_stem, AppState, AppStore,
    AssistantStateRecord, RedclawStateRecord, SpaceRecord,
};

pub(crate) struct WorkspaceHydrationSnapshot {
    categories: Vec<crate::SubjectCategory>,
    subjects: Vec<crate::SubjectRecord>,
    advisors: Vec<crate::AdvisorRecord>,
    chat_rooms: Vec<crate::ChatRoomRecord>,
    chatroom_messages: Vec<crate::ChatRoomMessageRecord>,
    memories: Vec<crate::UserMemoryRecord>,
    memory_history: Vec<crate::MemoryHistoryRecord>,
    media_assets: Vec<crate::MediaAssetRecord>,
    cover_assets: Vec<crate::CoverAssetRecord>,
    knowledge_notes: Vec<crate::KnowledgeNoteRecord>,
    knowledge_authors: Vec<crate::KnowledgeAuthorRecord>,
    youtube_videos: Vec<crate::YoutubeVideoRecord>,
    document_sources: Vec<crate::DocumentKnowledgeSourceRecord>,
    redclaw_state: RedclawStateRecord,
    work_items: Vec<crate::WorkItemRecord>,
}

pub(crate) struct KnowledgeHydrationSnapshot {
    knowledge_notes: Vec<crate::KnowledgeNoteRecord>,
    knowledge_authors: Vec<crate::KnowledgeAuthorRecord>,
    youtube_videos: Vec<crate::YoutubeVideoRecord>,
    document_sources: Vec<crate::DocumentKnowledgeSourceRecord>,
}

pub(crate) struct SubjectsHydrationSnapshot {
    categories: Vec<crate::SubjectCategory>,
    subjects: Vec<crate::SubjectRecord>,
}

pub(crate) struct MediaHydrationSnapshot {
    media_assets: Vec<crate::MediaAssetRecord>,
}

pub(crate) struct CoverHydrationSnapshot {
    cover_assets: Vec<crate::CoverAssetRecord>,
}

pub(crate) struct AdvisorsHydrationSnapshot {
    advisors: Vec<crate::AdvisorRecord>,
}

pub(crate) struct RedclawHydrationSnapshot {
    redclaw_state: RedclawStateRecord,
    work_items: Vec<crate::WorkItemRecord>,
}

#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct PersistedSessionArtifacts {
    session_id: String,
    updated_at: String,
    chat_messages: Vec<crate::ChatMessageRecord>,
    session_transcript_records: Vec<crate::SessionTranscriptRecord>,
    session_checkpoints: Vec<crate::SessionCheckpointRecord>,
    session_tool_results: Vec<crate::SessionToolResultRecord>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionIndexEntry {
    pub(crate) id: String,
    pub(crate) title: String,
    pub(crate) created_at: String,
    pub(crate) updated_at: String,
    #[serde(default)]
    pub(crate) metadata: Option<serde_json::Value>,
    #[serde(default)]
    pub(crate) archived: bool,
    #[serde(default)]
    pub(crate) archived_at: Option<i64>,
    #[serde(default)]
    pub(crate) starred: bool,
    #[serde(default)]
    pub(crate) message_count: i64,
    #[serde(default)]
    pub(crate) working_directory: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub(crate) enum SessionFileEntry {
    Session(crate::ChatSessionRecord),
    Message(crate::ChatMessageRecord),
    Context(crate::ChatSessionContextRecord),
    Transcript(crate::SessionTranscriptRecord),
    Checkpoint(crate::SessionCheckpointRecord),
    ToolResult(crate::SessionToolResultRecord),
}

pub(crate) fn load_workspace_hydration_snapshot(root: &Path) -> WorkspaceHydrationSnapshot {
    let assets_root = root.join("assets");
    let legacy_subjects_root = root.join("subjects");
    let subjects_root = if assets_root.join("catalog.json").exists()
        || !legacy_subjects_root.join("catalog.json").exists()
    {
        assets_root
    } else {
        legacy_subjects_root
    };
    WorkspaceHydrationSnapshot {
        categories: load_subject_categories_from_fs(&subjects_root),
        subjects: load_subjects_from_fs(&subjects_root),
        advisors: load_advisors_from_fs(&root.join("advisors")),
        chat_rooms: load_chat_rooms_from_fs(&root.join("chatrooms")),
        chatroom_messages: load_chatroom_messages_from_fs(&root.join("chatrooms")),
        memories: load_memories_from_fs(&root.join("memory")),
        memory_history: load_memory_history_from_fs(&root.join("memory")),
        media_assets: load_media_assets_from_fs(&root.join("media")),
        cover_assets: load_cover_assets_from_fs(&root.join("cover")),
        knowledge_notes: load_knowledge_notes_from_fs(&root.join("knowledge")),
        knowledge_authors: load_knowledge_authors_from_fs(&root.join("knowledge")),
        youtube_videos: load_youtube_videos_from_fs(&root.join("knowledge")),
        document_sources: load_document_sources_from_fs(&root.join("knowledge")),
        redclaw_state: load_redclaw_state_from_fs(&root.join("redclaw")),
        work_items: load_work_items_from_fs(&root.join("redclaw")),
    }
}

pub(crate) fn load_knowledge_hydration_snapshot(root: &Path) -> KnowledgeHydrationSnapshot {
    let knowledge_root = root.join("knowledge");
    KnowledgeHydrationSnapshot {
        knowledge_notes: load_knowledge_notes_from_fs(&knowledge_root),
        knowledge_authors: load_knowledge_authors_from_fs(&knowledge_root),
        youtube_videos: load_youtube_videos_from_fs(&knowledge_root),
        document_sources: load_document_sources_from_fs(&knowledge_root),
    }
}

pub(crate) fn apply_knowledge_hydration_snapshot(
    store: &mut AppStore,
    snapshot: KnowledgeHydrationSnapshot,
) {
    store.knowledge_notes = snapshot.knowledge_notes;
    store.knowledge_authors = snapshot.knowledge_authors;
    store.youtube_videos = snapshot.youtube_videos;
    store.document_sources = snapshot.document_sources;
}

pub(crate) fn load_subjects_hydration_snapshot(root: &Path) -> SubjectsHydrationSnapshot {
    let assets_root = root.join("assets");
    let legacy_subjects_root = root.join("subjects");
    let subjects_root = if assets_root.join("catalog.json").exists()
        || !legacy_subjects_root.join("catalog.json").exists()
    {
        assets_root
    } else {
        legacy_subjects_root
    };
    SubjectsHydrationSnapshot {
        categories: load_subject_categories_from_fs(&subjects_root),
        subjects: load_subjects_from_fs(&subjects_root),
    }
}

pub(crate) fn apply_subjects_hydration_snapshot(
    store: &mut AppStore,
    snapshot: SubjectsHydrationSnapshot,
) {
    subjects_store::replace_catalog(store, snapshot.categories, snapshot.subjects);
}

pub(crate) fn load_media_hydration_snapshot(root: &Path) -> MediaHydrationSnapshot {
    MediaHydrationSnapshot {
        media_assets: load_media_assets_from_fs(&root.join("media")),
    }
}

pub(crate) fn apply_media_hydration_snapshot(
    store: &mut AppStore,
    snapshot: MediaHydrationSnapshot,
) {
    media_store::replace_assets(store, snapshot.media_assets);
}

pub(crate) fn load_cover_hydration_snapshot(root: &Path) -> CoverHydrationSnapshot {
    CoverHydrationSnapshot {
        cover_assets: load_cover_assets_from_fs(&root.join("cover")),
    }
}

pub(crate) fn apply_cover_hydration_snapshot(
    store: &mut AppStore,
    snapshot: CoverHydrationSnapshot,
) {
    store.cover_assets = snapshot.cover_assets;
}

pub(crate) fn load_advisors_hydration_snapshot(root: &Path) -> AdvisorsHydrationSnapshot {
    AdvisorsHydrationSnapshot {
        advisors: load_advisors_from_fs(&root.join("advisors")),
    }
}

pub(crate) fn apply_advisors_hydration_snapshot(
    store: &mut AppStore,
    snapshot: AdvisorsHydrationSnapshot,
) {
    store.advisors = snapshot.advisors;
}

pub(crate) fn load_redclaw_hydration_snapshot(root: &Path) -> RedclawHydrationSnapshot {
    let redclaw_root = root.join("redclaw");
    RedclawHydrationSnapshot {
        redclaw_state: load_redclaw_state_from_fs(&redclaw_root),
        work_items: load_work_items_from_fs(&redclaw_root),
    }
}

pub(crate) fn apply_redclaw_hydration_snapshot(
    store: &mut AppStore,
    snapshot: RedclawHydrationSnapshot,
) {
    redclaw_store::replace_hydration_state(store, snapshot.redclaw_state, snapshot.work_items);
    sync_redclaw_job_definitions(store);
}

pub(crate) fn apply_workspace_hydration_snapshot(
    store: &mut AppStore,
    snapshot: WorkspaceHydrationSnapshot,
) {
    subjects_store::replace_catalog(store, snapshot.categories, snapshot.subjects);
    store.advisors = snapshot.advisors;
    store.chat_rooms = snapshot.chat_rooms;
    store.chatroom_messages = snapshot.chatroom_messages;
    store.memories = snapshot.memories;
    store.memory_history = snapshot.memory_history;
    media_store::replace_assets(store, snapshot.media_assets);
    store.cover_assets = snapshot.cover_assets;
    store.knowledge_notes = snapshot.knowledge_notes;
    store.knowledge_authors = snapshot.knowledge_authors;
    store.youtube_videos = snapshot.youtube_videos;
    store.document_sources = snapshot.document_sources;
    redclaw_store::replace_hydration_state(store, snapshot.redclaw_state, snapshot.work_items);
    sync_redclaw_job_definitions(store);
}

pub fn build_store_path() -> PathBuf {
    let base = config_dir()
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
    let redbox_dir = base.join("RedBox");
    let redbox_path = redbox_dir.join("redbox-state.json");

    if redbox_path.exists() {
        let _ = fs::create_dir_all(&redbox_dir);
        return redbox_path;
    }

    let _ = fs::create_dir_all(&redbox_dir);
    redbox_path
}

fn store_root_from_store_path(store_path: &Path) -> Result<PathBuf, String> {
    let root = store_path
        .parent()
        .ok_or_else(|| format!("{} store root is unavailable", app_brand_display_name()))?
        .to_path_buf();
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    Ok(root)
}

fn session_artifact_dir(store_path: &Path) -> Result<PathBuf, String> {
    let dir = store_root_from_store_path(store_path)?.join("session-artifacts");
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    Ok(dir)
}

fn session_artifact_path(store_path: &Path, session_id: &str) -> Result<PathBuf, String> {
    Ok(session_artifact_dir(store_path)?
        .join(format!("{}.json", storage_safe_file_stem(session_id))))
}

fn sessions_dir(store_path: &Path) -> Result<PathBuf, String> {
    let dir = store_root_from_store_path(store_path)?.join("sessions");
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    Ok(dir)
}

fn session_file_path(store_path: &Path, session_id: &str) -> Result<PathBuf, String> {
    Ok(sessions_dir(store_path)?.join(format!("{}.jsonl", storage_safe_file_stem(session_id))))
}

fn archived_dir(store_path: &Path) -> Result<PathBuf, String> {
    let dir = store_root_from_store_path(store_path)?.join("archived");
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    Ok(dir)
}

fn archived_session_path(store_path: &Path, session_id: &str) -> Result<PathBuf, String> {
    Ok(archived_dir(store_path)?.join(format!("{}.jsonl", storage_safe_file_stem(session_id))))
}

fn session_index_path(store_path: &Path) -> Result<PathBuf, String> {
    Ok(sessions_dir(store_path)?.join("index.json"))
}

fn write_session_file_entries(
    store_path: &Path,
    session_id: &str,
    entries: &[SessionFileEntry],
) -> Result<(), String> {
    let path = session_file_path(store_path, session_id)?;
    let tmp = path.with_extension("jsonl.tmp");
    let mut file = std::fs::File::create(&tmp).map_err(|error| error.to_string())?;
    use std::io::Write;
    for entry in entries {
        let line = serde_json::to_string(entry).map_err(|error| error.to_string())?;
        writeln!(file, "{}", line).map_err(|error| error.to_string())?;
    }
    fs::rename(&tmp, &path).map_err(|error| error.to_string())
}

fn write_session_index(store_path: &Path, entries: &[SessionIndexEntry]) -> Result<(), String> {
    let path = session_index_path(store_path)?;
    let serialized = serde_json::to_string_pretty(entries).map_err(|error| error.to_string())?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, serialized).map_err(|error| error.to_string())?;
    fs::rename(&tmp, &path).map_err(|error| error.to_string())
}

pub(crate) fn load_session_index(store_path: &Path) -> Result<Vec<SessionIndexEntry>, String> {
    let path = session_index_path(store_path)?;
    let content = fs::read_to_string(&path).map_err(|error| error.to_string())?;
    serde_json::from_str(&content).map_err(|error| error.to_string())
}

pub(crate) fn load_session_file(
    store_path: &Path,
    session_id: &str,
) -> Result<Vec<SessionFileEntry>, String> {
    let path = session_file_path(store_path, session_id)?;
    let file = fs::File::open(&path).map_err(|error| error.to_string())?;
    let reader = BufReader::new(file);
    let mut entries: Vec<SessionFileEntry> = Vec::new();
    for line in reader.lines() {
        let line = line.map_err(|error| error.to_string())?;
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        match serde_json::from_str::<SessionFileEntry>(trimmed) {
            Ok(entry) => entries.push(entry),
            Err(e) => eprintln!(
                "[{}] skip malformed JSONL line in {}.jsonl: {e}",
                app_brand_display_name(),
                storage_safe_file_stem(session_id),
            ),
        }
    }
    Ok(entries)
}

pub(crate) fn load_session_messages_from_file(
    store_path: &Path,
    session_id: &str,
) -> Result<Vec<crate::ChatMessageRecord>, String> {
    let path = session_file_path(store_path, session_id)?;
    let file = fs::File::open(&path).map_err(|error| error.to_string())?;
    let reader = BufReader::new(file);
    let mut seen = HashSet::new();
    let mut messages = Vec::new();
    for line in reader.lines() {
        let line = line.map_err(|error| error.to_string())?;
        let trimmed = line.trim();
        if trimmed.is_empty() || !trimmed.contains("\"type\":\"message\"") {
            continue;
        }
        match serde_json::from_str::<crate::ChatMessageRecord>(trimmed) {
            Ok(message)
                if message.session_id == session_id
                    && (message.role == "user" || message.role == "assistant")
                    && seen.insert(message.id.clone()) =>
            {
                messages.push(message);
            }
            Ok(_) => {}
            Err(e) => eprintln!(
                "[{}] skip malformed message line in {}.jsonl: {e}",
                app_brand_display_name(),
                storage_safe_file_stem(session_id),
            ),
        }
    }
    messages.sort_by(|a, b| a.created_at.cmp(&b.created_at));
    Ok(messages)
}

pub(crate) fn apply_session_file_entries_to_store(
    store: &mut AppStore,
    entries: Vec<SessionFileEntry>,
) {
    let mut message_ids = store
        .chat_messages
        .iter()
        .map(|item| item.id.clone())
        .collect::<HashSet<_>>();
    let mut context_session_ids = store
        .session_context_records
        .iter()
        .map(|item| item.session_id.clone())
        .collect::<HashSet<_>>();
    let mut transcript_ids = store
        .session_transcript_records
        .iter()
        .map(|item| item.id.clone())
        .collect::<HashSet<_>>();
    let mut checkpoint_ids = store
        .session_checkpoints
        .iter()
        .map(|item| item.id.clone())
        .collect::<HashSet<_>>();
    let mut tool_result_ids = store
        .session_tool_results
        .iter()
        .map(|item| item.id.clone())
        .collect::<HashSet<_>>();
    for entry in entries {
        match entry {
            SessionFileEntry::Session(session) => {
                if !store.chat_sessions.iter().any(|item| item.id == session.id) {
                    store.chat_sessions.push(session);
                }
            }
            SessionFileEntry::Message(msg) => {
                if message_ids.insert(msg.id.clone()) {
                    store.chat_messages.push(msg);
                }
            }
            SessionFileEntry::Context(ctx) => {
                if context_session_ids.insert(ctx.session_id.clone()) {
                    store.session_context_records.push(ctx);
                }
            }
            SessionFileEntry::Transcript(tr) => {
                if transcript_ids.insert(tr.id.clone()) {
                    store.session_transcript_records.push(tr);
                }
            }
            SessionFileEntry::Checkpoint(ch) => {
                if checkpoint_ids.insert(ch.id.clone()) {
                    store.session_checkpoints.push(ch);
                }
            }
            SessionFileEntry::ToolResult(tr) => {
                if tool_result_ids.insert(tr.id.clone()) {
                    store.session_tool_results.push(tr);
                }
            }
        }
    }
}

fn load_sessions_from_jsonl(store_path: &Path, store: &mut AppStore) -> Result<(), String> {
    let index = match load_session_index(store_path) {
        Ok(idx) => idx,
        Err(_) => return Ok(()),
    };
    store.chat_sessions.extend(
        index
            .into_iter()
            .filter(|entry| !entry.archived)
            .map(|entry| crate::ChatSessionRecord {
                id: entry.id,
                title: entry.title,
                created_at: entry.created_at,
                updated_at: entry.updated_at,
                metadata: entry.metadata,
                deleted_at: None,
                starred: entry.starred,
                archived: false,
                archived_at: None,
            }),
    );
    Ok(())
}

pub(crate) fn is_session_file_loaded(store: &AppStore, session_id: &str) -> bool {
    store
        .chat_messages
        .iter()
        .any(|item| item.session_id == session_id)
        || store
            .session_context_records
            .iter()
            .any(|item| item.session_id == session_id)
        || store
            .session_transcript_records
            .iter()
            .any(|item| item.session_id == session_id)
        || store
            .session_checkpoints
            .iter()
            .any(|item| item.session_id == session_id)
        || store
            .session_tool_results
            .iter()
            .any(|item| item.session_id == session_id)
}

pub(crate) fn archive_session(store_path: &Path, session_id: &str) -> Result<(), String> {
    let src = session_file_path(store_path, session_id)?;
    let dst = archived_session_path(store_path, session_id)?;
    if src.exists() {
        fs::rename(&src, &dst).map_err(|error| error.to_string())?;
    }
    // Update index to mark as archived
    let mut index = load_session_index(store_path).unwrap_or_default();
    if let Some(entry) = index.iter_mut().find(|e| e.id == session_id) {
        entry.archived = true;
        entry.archived_at = Some(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0),
        );
    }
    write_session_index(store_path, &index)
}

pub(crate) fn unarchive_session(store_path: &Path, session_id: &str) -> Result<(), String> {
    let src = archived_session_path(store_path, session_id)?;
    let dst = session_file_path(store_path, session_id)?;
    if src.exists() {
        fs::rename(&src, &dst).map_err(|error| error.to_string())?;
    }
    // Update index to mark as unarchived
    let mut index = load_session_index(store_path).unwrap_or_default();
    if let Some(entry) = index.iter_mut().find(|e| e.id == session_id) {
        entry.archived = false;
        entry.archived_at = None;
    }
    write_session_index(store_path, &index)?;
    // Reload session into memory is handled by the caller via load_session_file
    Ok(())
}

pub(crate) fn delete_session_file(store_path: &Path, session_id: &str) -> Result<(), String> {
    let path = session_file_path(store_path, session_id)?;
    if path.exists() {
        fs::remove_file(&path).map_err(|error| error.to_string())?;
    }
    let archived = archived_session_path(store_path, session_id)?;
    if archived.exists() {
        fs::remove_file(&archived).map_err(|error| error.to_string())?;
    }
    // Remove from index
    let mut index = load_session_index(store_path).unwrap_or_default();
    index.retain(|e| e.id != session_id);
    write_session_index(store_path, &index)
}

pub(crate) fn enforce_disk_retention(store_path: &Path) {
    const MAX_DISK_MB: u64 = 500;
    let sessions_dir = match sessions_dir(store_path) {
        Ok(dir) => dir,
        Err(_) => return,
    };
    let total_size = dir_size(&sessions_dir);
    if total_size < MAX_DISK_MB * 1024 * 1024 {
        return;
    }
    // Load index, sort by updated_at ascending (oldest first), prune until under limit
    let mut index = match load_session_index(store_path) {
        Ok(idx) => idx,
        Err(_) => return,
    };
    index.retain(|e| !e.archived);
    index.sort_by(|a, b| a.updated_at.cmp(&b.updated_at));
    let mut removed_size: u64 = 0;
    for entry in &index {
        if total_size.saturating_sub(removed_size) < MAX_DISK_MB * 1024 * 1024 {
            break;
        }
        let path = match session_file_path(store_path, &entry.id) {
            Ok(p) => p,
            Err(_) => continue,
        };
        if let Ok(meta) = path.metadata() {
            removed_size += meta.len();
        }
        let _ = fs::remove_file(&path);
    }
    // Rebuild index without removed entries
    let remaining_ids: HashSet<&str> = index.iter().map(|e| e.id.as_str()).collect();
    let mut new_index = match load_session_index(store_path) {
        Ok(idx) => idx,
        Err(_) => return,
    };
    new_index.retain(|e| remaining_ids.contains(e.id.as_str()));
    let _ = write_session_index(store_path, &new_index);
}

fn dir_size(dir: &Path) -> u64 {
    let mut total: u64 = 0;
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            if let Ok(meta) = entry.metadata() {
                if meta.is_file() {
                    total += meta.len();
                }
            }
        }
    }
    total
}

fn append_session_artifacts_bucket<'a>(
    buckets: &'a mut BTreeMap<String, PersistedSessionArtifacts>,
    session_id: &str,
) -> &'a mut PersistedSessionArtifacts {
    buckets
        .entry(session_id.to_string())
        .or_insert_with(|| PersistedSessionArtifacts {
            session_id: session_id.to_string(),
            updated_at: now_iso(),
            ..PersistedSessionArtifacts::default()
        })
}

fn take_session_artifacts_from_store(store: &mut AppStore) -> Vec<PersistedSessionArtifacts> {
    let mut buckets = BTreeMap::<String, PersistedSessionArtifacts>::new();

    for message in std::mem::take(&mut store.chat_messages) {
        append_session_artifacts_bucket(&mut buckets, &message.session_id)
            .chat_messages
            .push(message);
    }
    for record in std::mem::take(&mut store.session_transcript_records) {
        append_session_artifacts_bucket(&mut buckets, &record.session_id)
            .session_transcript_records
            .push(record);
    }
    for record in std::mem::take(&mut store.session_checkpoints) {
        append_session_artifacts_bucket(&mut buckets, &record.session_id)
            .session_checkpoints
            .push(record);
    }
    for record in std::mem::take(&mut store.session_tool_results) {
        append_session_artifacts_bucket(&mut buckets, &record.session_id)
            .session_tool_results
            .push(record);
    }

    buckets
        .into_values()
        .filter(|item| {
            !item.chat_messages.is_empty()
                || !item.session_transcript_records.is_empty()
                || !item.session_checkpoints.is_empty()
                || !item.session_tool_results.is_empty()
        })
        .collect()
}

fn dedupe_session_artifacts(artifacts: &mut PersistedSessionArtifacts) {
    let mut message_ids = HashSet::new();
    artifacts
        .chat_messages
        .retain(|item| message_ids.insert(item.id.clone()));

    let mut transcript_ids = HashSet::new();
    artifacts
        .session_transcript_records
        .retain(|item| transcript_ids.insert(item.id.clone()));

    let mut checkpoint_ids = HashSet::new();
    artifacts
        .session_checkpoints
        .retain(|item| checkpoint_ids.insert(item.id.clone()));

    let mut tool_result_ids = HashSet::new();
    artifacts
        .session_tool_results
        .retain(|item| tool_result_ids.insert(item.id.clone()));
}

fn apply_session_artifacts_to_store(store: &mut AppStore, artifacts: PersistedSessionArtifacts) {
    store.chat_messages.extend(artifacts.chat_messages);
    store
        .session_transcript_records
        .extend(artifacts.session_transcript_records);
    store
        .session_checkpoints
        .extend(artifacts.session_checkpoints);
    store
        .session_tool_results
        .extend(artifacts.session_tool_results);
}

fn load_session_artifacts_from_disk(
    store_path: &Path,
) -> Result<Vec<PersistedSessionArtifacts>, String> {
    let dir = session_artifact_dir(store_path)?;
    let mut items = Vec::new();
    for entry in fs::read_dir(dir).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let content = fs::read_to_string(&path).map_err(|error| error.to_string())?;
        let artifacts = serde_json::from_str::<PersistedSessionArtifacts>(&content)
            .map_err(|error| error.to_string())?;
        if artifacts.session_id.trim().is_empty() {
            continue;
        }
        items.push(artifacts);
    }
    items.sort_by(|a, b| a.session_id.cmp(&b.session_id));
    Ok(items)
}

fn restore_session_artifacts_from_disk(
    store_path: &Path,
    store: &mut AppStore,
) -> Result<HashSet<String>, String> {
    let mut loaded_ids = HashSet::new();
    for artifacts in load_session_artifacts_from_disk(store_path)? {
        loaded_ids.insert(artifacts.session_id.clone());
        apply_session_artifacts_to_store(store, artifacts);
    }
    Ok(loaded_ids)
}

fn write_session_artifacts_to_disk(
    store_path: &Path,
    artifacts: &[PersistedSessionArtifacts],
) -> Result<(), String> {
    let dir = session_artifact_dir(store_path)?;
    let mut retained_paths = HashSet::<PathBuf>::new();
    for item in artifacts {
        let path = session_artifact_path(store_path, &item.session_id)?;
        let serialized = serde_json::to_string_pretty(item).map_err(|error| error.to_string())?;
        fs::write(&path, serialized).map_err(|error| error.to_string())?;
        retained_paths.insert(path);
    }
    for entry in fs::read_dir(dir).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        if retained_paths.contains(&path) {
            continue;
        }
        let _ = fs::remove_file(path);
    }
    Ok(())
}

fn ensure_builtin_skills_present(store: &mut AppStore) -> bool {
    let builtins = builtin_skill_records();
    let builtin_names = builtins
        .iter()
        .map(|skill| skill.name.to_ascii_lowercase())
        .collect::<HashSet<_>>();
    let mut changed = false;
    let before = store.skills.len();
    store.skills.retain(|skill| {
        let is_builtin =
            skill.is_builtin.unwrap_or(false) || skill.source_scope.as_deref() == Some("builtin");
        !is_builtin || builtin_names.contains(&skill.name.to_ascii_lowercase())
    });
    if store.skills.len() != before {
        changed = true;
    }

    for builtin in builtins {
        let existing = store
            .skills
            .iter()
            .position(|skill| skill.name.eq_ignore_ascii_case(&builtin.name));
        if let Some(index) = existing {
            let refreshed = SkillRecord {
                disabled: Some(false),
                ..builtin
            };
            if skill_record_differs(&store.skills[index], &refreshed) {
                store.skills[index] = refreshed;
                changed = true;
            }
        } else {
            store.skills.push(builtin);
            changed = true;
        }
    }
    changed
}

fn skill_record_differs(left: &SkillRecord, right: &SkillRecord) -> bool {
    left.name != right.name
        || left.description != right.description
        || left.location != right.location
        || left.body != right.body
        || left.source_scope != right.source_scope
        || left.is_builtin != right.is_builtin
        || left.disabled != right.disabled
}

pub fn default_store() -> AppStore {
    let timestamp = now_iso();
    AppStore {
        settings: json!({}),
        spaces: vec![SpaceRecord {
            id: "default".to_string(),
            name: "默认空间".to_string(),
            created_at: timestamp.clone(),
            updated_at: timestamp,
        }],
        active_space_id: "default".to_string(),
        subjects: Vec::new(),
        categories: Vec::new(),
        advisors: Vec::new(),
        advisor_videos: Vec::new(),
        chat_rooms: Vec::new(),
        chatroom_messages: Vec::new(),
        wechat_official_bindings: Vec::new(),
        embedding_cache: Vec::new(),
        similarity_cache: Vec::new(),
        wander_history: Vec::new(),
        chat_sessions: Vec::new(),
        chat_messages: Vec::new(),
        session_context_records: Vec::new(),
        manuscript_write_proposals: Vec::new(),
        youtube_videos: Vec::new(),
        knowledge_notes: Vec::new(),
        knowledge_authors: Vec::new(),
        document_sources: Vec::new(),
        session_transcript_records: Vec::new(),
        session_checkpoints: Vec::new(),
        session_tool_results: Vec::new(),
        runtime_tasks: Vec::new(),
        runtime_task_traces: Vec::new(),
        collab_sessions: Vec::new(),
        collab_members: Vec::new(),
        collab_tasks: Vec::new(),
        collab_mailbox_messages: Vec::new(),
        collab_progress_reports: Vec::new(),
        review_dockets: Vec::new(),
        review_decisions: Vec::new(),
        cli_tools: Vec::new(),
        cli_environments: Vec::new(),
        cli_manifests: Vec::new(),
        cli_executions: Vec::new(),
        cli_escalations: Vec::new(),
        cli_verifications: Vec::new(),
        debug_logs: Vec::new(),
        archive_profiles: Vec::new(),
        archive_samples: Vec::new(),
        memories: Vec::new(),
        memory_history: Vec::new(),
        mcp_servers: Vec::new(),
        runtime_hooks: Vec::new(),
        skills: builtin_skill_records(),
        assistant_state: AssistantStateRecord {
            enabled: true,
            auto_start: true,
            keep_alive_when_no_window: true,
            host: "127.0.0.1".to_string(),
            port: 31937,
            listening: false,
            lock_state: "passive".to_string(),
            blocked_by: None,
            last_error: Some("RedClaw assistant daemon is idle.".to_string()),
            active_task_count: 0,
            queued_peer_count: 0,
            in_flight_keys: Vec::new(),
            feishu: json!({
                "enabled": false,
                "receiveMode": "webhook",
                "endpointPath": "/hooks/feishu/events",
                "replyUsingChatId": true,
                "webhookUrl": "",
                "websocketRunning": false
            }),
            relay: json!({
                "enabled": true,
                "endpointPath": "/hooks/channel/relay",
                "authToken": "",
                "webhookUrl": ""
            }),
            weixin: json!({
                "enabled": false,
                "endpointPath": "/hooks/weixin/relay",
                "authToken": "",
                "accountId": "",
                "autoStartSidecar": false,
                "cursorFile": "",
                "sidecarCommand": "",
                "sidecarArgs": [],
                "sidecarCwd": "",
                "sidecarEnv": {},
                "webhookUrl": "",
                "sidecarRunning": false,
                "connected": false,
                "stateDir": "",
                "availableAccountIds": []
            }),
            knowledge_api: json!({
                "endpointPath": "/api/knowledge",
                "webhookUrl": ""
            }),
        },
        redclaw_state: RedclawStateRecord {
            enabled: false,
            lock_state: "owner".to_string(),
            blocked_by: None,
            interval_minutes: 20,
            keep_alive_when_no_window: true,
            max_projects_per_tick: 1,
            max_automation_per_tick: 2,
            is_ticking: false,
            current_project_id: None,
            current_automation_task_id: None,
            next_automation_fire_at: None,
            in_flight_task_ids: Vec::new(),
            in_flight_long_cycle_task_ids: Vec::new(),
            heartbeat_in_flight: false,
            last_tick_at: None,
            next_tick_at: None,
            next_maintenance_at: None,
            last_error: Some("RedClaw runner is idle.".to_string()),
            heartbeat: json!({
                "enabled": true,
                "intervalMinutes": 30,
                "suppressEmptyReport": true,
                "reportToMainSession": true
            }),
            scheduled_tasks: Vec::new(),
            long_cycle_tasks: Vec::new(),
            projects: Vec::new(),
        },
        redclaw_job_definitions: Vec::new(),
        redclaw_job_executions: Vec::new(),
        media_assets: Vec::new(),
        cover_assets: Vec::new(),
        work_items: Vec::new(),
        legacy_imported_at: None,
        legacy_import_source: None,
    }
}

fn should_enable_assistant_daemon_by_default(state: &AssistantStateRecord) -> bool {
    if state.enabled || !state.auto_start || state.listening {
        return false;
    }

    if state.last_error.as_deref() == Some("RedClaw assistant daemon stopped.") {
        return false;
    }

    state.active_task_count == 0
        && state.queued_peer_count == 0
        && state.in_flight_keys.is_empty()
        && matches!(
            state.last_error.as_deref(),
            None | Some("RedClaw assistant daemon is idle.")
        )
}

pub fn load_store(path: &PathBuf) -> AppStore {
    let content = match fs::read_to_string(path) {
        Ok(content) => content,
        Err(_) => return default_store(),
    };
    let mut store = serde_json::from_str(&content).unwrap_or_else(|_| default_store());
    store.debug_logs.clear();
    store.assistant_state.listening = false;
    if store.assistant_state.last_error.as_deref()
        == Some("RedClaw assistant daemon local listener is running.")
    {
        store.assistant_state.last_error = Some("RedClaw assistant daemon is idle.".to_string());
    }
    let embedded_session_artifacts = take_session_artifacts_from_store(&mut store);

    // Prefer per-session JSONL if available, fall back to legacy disk artifacts
    let mut loaded_from_legacy = false;
    let disk_session_ids = if session_index_path(path).is_ok_and(|p| p.exists()) {
        if let Err(e) = load_sessions_from_jsonl(path, &mut store) {
            eprintln!(
                "[{}] JSONL session load failed, falling back to legacy: {e}",
                app_brand_display_name()
            );
            let ids = restore_session_artifacts_from_disk(path, &mut store).unwrap_or_default();
            loaded_from_legacy = true;
            ids
        } else {
            HashSet::new()
        }
    } else {
        let ids = restore_session_artifacts_from_disk(path, &mut store).unwrap_or_default();
        loaded_from_legacy = true;
        ids
    };

    let mut migrated_session_artifacts = false;
    if !embedded_session_artifacts.is_empty() {
        for artifacts in embedded_session_artifacts {
            if disk_session_ids.contains(&artifacts.session_id) {
                continue;
            }
            apply_session_artifacts_to_store(&mut store, artifacts);
            migrated_session_artifacts = true;
        }
    }
    let skills_migrated = ensure_builtin_skills_present(&mut store);
    let assistant_daemon_migrated =
        if should_enable_assistant_daemon_by_default(&store.assistant_state) {
            store.assistant_state.enabled = true;
            true
        } else {
            false
        };
    crate::session_manager::enforce_default_retention(&mut store);
    if skills_migrated
        || assistant_daemon_migrated
        || migrated_session_artifacts
        || loaded_from_legacy
    {
        let _ = persist_store(path, &store);
    }
    store
}

pub fn persist_store(path: &PathBuf, store: &AppStore) -> Result<(), String> {
    let mut snapshot = store.clone();
    crate::session_manager::enforce_default_retention(&mut snapshot);
    crate::auth::sanitize_store_for_persist(&mut snapshot);
    let mut session_artifacts = take_session_artifacts_from_store(&mut snapshot);
    for artifact in &mut session_artifacts {
        dedupe_session_artifacts(artifact);
    }
    let sessions = std::mem::take(&mut snapshot.chat_sessions);
    let context_records = std::mem::take(&mut snapshot.session_context_records);
    snapshot.debug_logs.clear();

    // Write per-session JSONL files
    let existing_index = load_session_index(path)
        .unwrap_or_default()
        .into_iter()
        .map(|entry| (entry.id.clone(), entry))
        .collect::<HashMap<_, _>>();
    let mut index_entries: Vec<SessionIndexEntry> = Vec::new();
    for session in &sessions {
        let session_id = &session.id;
        let mut entries: Vec<SessionFileEntry> = Vec::new();
        entries.push(SessionFileEntry::Session(session.clone()));

        // Collect messages for this session
        let artifact = session_artifacts
            .iter()
            .find(|a| a.session_id == *session_id);
        let session_context_records = context_records
            .iter()
            .filter(|c| c.session_id == *session_id)
            .cloned()
            .collect::<Vec<_>>();
        let message_count = artifact
            .map(|a| a.chat_messages.len() as i64)
            .or_else(|| {
                existing_index
                    .get(session_id)
                    .map(|entry| entry.message_count)
            })
            .unwrap_or(0);
        if let Some(artifact) = artifact {
            for msg in &artifact.chat_messages {
                entries.push(SessionFileEntry::Message(msg.clone()));
            }
            for tr in &artifact.session_transcript_records {
                entries.push(SessionFileEntry::Transcript(tr.clone()));
            }
            for ch in &artifact.session_checkpoints {
                entries.push(SessionFileEntry::Checkpoint(ch.clone()));
            }
            for tr in &artifact.session_tool_results {
                entries.push(SessionFileEntry::ToolResult(tr.clone()));
            }
        }

        // Context records
        for ctx in &session_context_records {
            entries.push(SessionFileEntry::Context(ctx.clone()));
        }

        let should_write_session_file = artifact.is_some()
            || !session_context_records.is_empty()
            || session_file_path(path, session_id)
                .map(|file_path| !file_path.exists())
                .unwrap_or(true);
        if should_write_session_file {
            let _ = write_session_file_entries(path, session_id, &entries);
        }

        index_entries.push(SessionIndexEntry {
            id: session.id.clone(),
            title: session.title.clone(),
            created_at: session.created_at.clone(),
            updated_at: session.updated_at.clone(),
            metadata: session.metadata.clone(),
            archived: false,
            archived_at: None,
            starred: session.starred,
            message_count,
            working_directory: session
                .metadata
                .as_ref()
                .and_then(|m| crate::payload_string(m, "workingDirectory")),
        });
    }
    let _ = write_session_index(path, &index_entries);
    enforce_disk_retention(path);

    // Still write legacy format (dual-write during transition)
    write_session_artifacts_to_disk(path, &session_artifacts)?;
    let serialized = serde_json::to_string_pretty(&snapshot).map_err(|error| error.to_string())?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::write(path, serialized).map_err(|error| error.to_string())
}

pub fn with_store_mut<T>(
    state: &State<'_, AppState>,
    mutator: impl FnOnce(&mut AppStore) -> Result<T, String>,
) -> Result<T, String> {
    let mut store = state.store.lock().map_err(|_| "状态锁已损坏".to_string())?;
    let result = mutator(&mut store)?;
    let retention = crate::session_manager::enforce_default_retention(&mut store);
    drop(store);
    for session_id in retention.removed_session_ids {
        let _ = crate::runtime::remove_session_bundle(state, &session_id);
        if let Ok(mut guard) = state.chat_runtime_states.lock() {
            guard.remove(&session_id);
        }
    }
    schedule_store_persist(state);
    Ok(result)
}

pub fn with_store<T>(
    state: &State<'_, AppState>,
    reader: impl FnOnce(MutexGuard<'_, AppStore>) -> Result<T, String>,
) -> Result<T, String> {
    let store = state.store.lock().map_err(|_| "状态锁已损坏".to_string())?;
    reader(store)
}

pub fn hydrate_store_from_workspace_files(
    store: &mut AppStore,
    store_path: &Path,
) -> Result<(), String> {
    let active_space_id = spaces_store::active_space_id(store);
    let root = active_space_workspace_root_from_store(store, &active_space_id, store_path)?;
    let snapshot = load_workspace_hydration_snapshot(&root);
    apply_workspace_hydration_snapshot(store, snapshot);
    Ok(())
}

pub fn ensure_store_hydrated_for_knowledge(state: &State<'_, AppState>) -> Result<(), String> {
    let root = with_store(state, |store| {
        let needs_hydration = store.knowledge_notes.is_empty()
            || store.knowledge_authors.is_empty()
            || store.youtube_videos.is_empty()
            || store.document_sources.is_empty();
        if !needs_hydration {
            return Ok(None);
        }
        let active_space_id = spaces_store::active_space_id(&store);
        Ok(Some(active_space_workspace_root_from_store(
            &store,
            &active_space_id,
            &state.store_path,
        )?))
    })?;
    if let Some(root) = root {
        let snapshot = load_knowledge_hydration_snapshot(&root);
        with_store_mut(state, |store| {
            apply_knowledge_hydration_snapshot(store, snapshot);
            Ok(())
        })?;
    }
    Ok(())
}

pub fn ensure_store_hydrated_for_subjects(state: &State<'_, AppState>) -> Result<(), String> {
    let root = with_store(state, |store| {
        let needs_hydration = should_hydrate_subjects(&store);
        if !needs_hydration {
            return Ok(None);
        }
        let active_space_id = spaces_store::active_space_id(&store);
        Ok(Some(active_space_workspace_root_from_store(
            &store,
            &active_space_id,
            &state.store_path,
        )?))
    })?;
    if let Some(root) = root {
        let snapshot = load_subjects_hydration_snapshot(&root);
        with_store_mut(state, |store| {
            apply_subjects_hydration_snapshot(store, snapshot);
            Ok(())
        })?;
    }
    Ok(())
}

fn should_hydrate_subjects(store: &AppStore) -> bool {
    subjects_store::catalog_is_empty(store)
}

pub fn ensure_store_hydrated_for_media(state: &State<'_, AppState>) -> Result<(), String> {
    let root = with_store(state, |store| {
        if media_store::count_assets(&store) > 0 {
            return Ok(None);
        }
        let active_space_id = spaces_store::active_space_id(&store);
        Ok(Some(active_space_workspace_root_from_store(
            &store,
            &active_space_id,
            &state.store_path,
        )?))
    })?;
    if let Some(root) = root {
        let snapshot = load_media_hydration_snapshot(&root);
        with_store_mut(state, |store| {
            apply_media_hydration_snapshot(store, snapshot);
            Ok(())
        })?;
    }
    Ok(())
}

pub fn ensure_store_hydrated_for_cover(state: &State<'_, AppState>) -> Result<(), String> {
    let root = with_store(state, |store| {
        if !store.cover_assets.is_empty() {
            return Ok(None);
        }
        let active_space_id = spaces_store::active_space_id(&store);
        Ok(Some(active_space_workspace_root_from_store(
            &store,
            &active_space_id,
            &state.store_path,
        )?))
    })?;
    if let Some(root) = root {
        let snapshot = load_cover_hydration_snapshot(&root);
        with_store_mut(state, |store| {
            apply_cover_hydration_snapshot(store, snapshot);
            Ok(())
        })?;
    }
    Ok(())
}

pub fn ensure_store_hydrated_for_work(state: &State<'_, AppState>) -> Result<(), String> {
    let root = with_store(state, |store| {
        if redclaw_store::has_work_items(&store) {
            return Ok(None);
        }
        let active_space_id = spaces_store::active_space_id(&store);
        Ok(Some(active_space_workspace_root_from_store(
            &store,
            &active_space_id,
            &state.store_path,
        )?))
    })?;
    if let Some(root) = root {
        let snapshot = load_redclaw_hydration_snapshot(&root);
        with_store_mut(state, |store| {
            apply_redclaw_hydration_snapshot(store, snapshot);
            Ok(())
        })?;
    }
    Ok(())
}

pub fn ensure_store_hydrated_for_advisors(state: &State<'_, AppState>) -> Result<(), String> {
    let root = with_store(state, |store| {
        if !store.advisors.is_empty() {
            return Ok(None);
        }
        let active_space_id = spaces_store::active_space_id(&store);
        Ok(Some(active_space_workspace_root_from_store(
            &store,
            &active_space_id,
            &state.store_path,
        )?))
    })?;
    if let Some(root) = root {
        let snapshot = load_advisors_hydration_snapshot(&root);
        with_store_mut(state, |store| {
            apply_advisors_hydration_snapshot(store, snapshot);
            Ok(())
        })?;
    }
    Ok(())
}

pub fn ensure_store_hydrated_for_redclaw(state: &State<'_, AppState>) -> Result<(), String> {
    let root = with_store(state, |store| {
        let needs_hydration = redclaw_store::needs_workspace_hydration(&store);
        if !needs_hydration {
            return Ok(None);
        }
        let active_space_id = spaces_store::active_space_id(&store);
        Ok(Some(active_space_workspace_root_from_store(
            &store,
            &active_space_id,
            &state.store_path,
        )?))
    })?;
    if let Some(root) = root {
        let snapshot = load_workspace_hydration_snapshot(&root);
        with_store_mut(state, |store| {
            apply_workspace_hydration_snapshot(store, snapshot);
            Ok(())
        })?;
    }
    Ok(())
}

fn schedule_store_persist(state: &State<'_, AppState>) {
    let path = state.store_path.clone();
    let store_handle = state.store.clone();
    state.store_persist_version.fetch_add(1, Ordering::SeqCst);
    let latest = state.store_persist_version.clone();
    let scheduled = state.store_persist_scheduled.clone();
    if scheduled.swap(true, Ordering::SeqCst) {
        return;
    }
    tauri::async_runtime::spawn_blocking(move || {
        loop {
            let target_version = latest.load(Ordering::SeqCst);
            std::thread::sleep(Duration::from_millis(180));
            if target_version != latest.load(Ordering::SeqCst) {
                continue;
            }
            let mut snapshot = match store_handle.lock() {
                Ok(store) => store.clone(),
                Err(_) => {
                    eprintln!(
                        "[{} async persist] store lock poisoned",
                        app_brand_display_name()
                    );
                    scheduled.store(false, Ordering::SeqCst);
                    return;
                }
            };
            crate::session_manager::enforce_default_retention(&mut snapshot);
            crate::auth::sanitize_store_for_persist(&mut snapshot);
            let mut session_artifacts = take_session_artifacts_from_store(&mut snapshot);
            for artifact in &mut session_artifacts {
                dedupe_session_artifacts(artifact);
            }
            let sessions = std::mem::take(&mut snapshot.chat_sessions);
            let context_records = std::mem::take(&mut snapshot.session_context_records);
            snapshot.debug_logs.clear();

            // Write per-session JSONL files
            let existing_index = load_session_index(&path)
                .unwrap_or_default()
                .into_iter()
                .map(|entry| (entry.id.clone(), entry))
                .collect::<HashMap<_, _>>();
            let mut index_entries: Vec<SessionIndexEntry> = Vec::new();
            for session in &sessions {
                let session_id = &session.id;
                let mut entries: Vec<SessionFileEntry> = Vec::new();
                entries.push(SessionFileEntry::Session(session.clone()));

                let artifact = session_artifacts
                    .iter()
                    .find(|a| a.session_id == *session_id);
                let session_context_records = context_records
                    .iter()
                    .filter(|c| c.session_id == *session_id)
                    .cloned()
                    .collect::<Vec<_>>();
                let message_count = artifact
                    .map(|a| a.chat_messages.len() as i64)
                    .or_else(|| {
                        existing_index
                            .get(session_id)
                            .map(|entry| entry.message_count)
                    })
                    .unwrap_or(0);
                if let Some(artifact) = artifact {
                    for msg in &artifact.chat_messages {
                        entries.push(SessionFileEntry::Message(msg.clone()));
                    }
                    for tr in &artifact.session_transcript_records {
                        entries.push(SessionFileEntry::Transcript(tr.clone()));
                    }
                    for ch in &artifact.session_checkpoints {
                        entries.push(SessionFileEntry::Checkpoint(ch.clone()));
                    }
                    for tr in &artifact.session_tool_results {
                        entries.push(SessionFileEntry::ToolResult(tr.clone()));
                    }
                }
                for ctx in &session_context_records {
                    entries.push(SessionFileEntry::Context(ctx.clone()));
                }

                let should_write_session_file = artifact.is_some()
                    || !session_context_records.is_empty()
                    || session_file_path(&path, session_id)
                        .map(|file_path| !file_path.exists())
                        .unwrap_or(true);
                if should_write_session_file {
                    let _ = write_session_file_entries(&path, session_id, &entries);
                }

                index_entries.push(SessionIndexEntry {
                    id: session.id.clone(),
                    title: session.title.clone(),
                    created_at: session.created_at.clone(),
                    updated_at: session.updated_at.clone(),
                    metadata: session.metadata.clone(),
                    archived: false,
                    archived_at: None,
                    starred: session.starred,
                    message_count,
                    working_directory: session
                        .metadata
                        .as_ref()
                        .and_then(|m| crate::payload_string(m, "workingDirectory")),
                });
            }
            let _ = write_session_index(&path, &index_entries);
            enforce_disk_retention(&path);

            let serialized = match serde_json::to_string_pretty(&snapshot) {
                Ok(value) => value,
                Err(error) => {
                    eprintln!(
                        "[{} async persist] serialize failed: {error}",
                        app_brand_display_name()
                    );
                    scheduled.store(false, Ordering::SeqCst);
                    return;
                }
            };
            if target_version != latest.load(Ordering::SeqCst) {
                continue;
            }
            if let Err(error) = write_session_artifacts_to_disk(&path, &session_artifacts) {
                eprintln!(
                    "[{} async persist] session artifact write failed: {error}",
                    app_brand_display_name()
                );
                scheduled.store(false, Ordering::SeqCst);
                return;
            }
            if let Some(parent) = path.parent() {
                if let Err(error) = fs::create_dir_all(parent) {
                    eprintln!(
                        "[{} async persist] create dir failed: {error}",
                        app_brand_display_name()
                    );
                    scheduled.store(false, Ordering::SeqCst);
                    return;
                }
            }
            let tmp_path = path.with_extension(format!("json.tmp.{target_version}"));
            if let Err(error) = fs::write(&tmp_path, serialized) {
                eprintln!(
                    "[{} async persist] temp write failed: {error}",
                    app_brand_display_name()
                );
                scheduled.store(false, Ordering::SeqCst);
                return;
            }
            if target_version != latest.load(Ordering::SeqCst) {
                let _ = fs::remove_file(&tmp_path);
                continue;
            }
            if let Err(error) = fs::rename(&tmp_path, &path) {
                let _ = fs::remove_file(&tmp_path);
                eprintln!(
                    "[{} async persist] rename failed: {error}",
                    app_brand_display_name()
                );
                scheduled.store(false, Ordering::SeqCst);
                return;
            }
            scheduled.store(false, Ordering::SeqCst);
            if target_version == latest.load(Ordering::SeqCst) {
                break;
            }
            if scheduled.swap(true, Ordering::SeqCst) {
                break;
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn test_store_path(label: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after unix epoch")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("redbox-persistence-{label}-{unique}"));
        fs::create_dir_all(&root).expect("temp dir should be creatable");
        root.join("redbox-state.json")
    }

    fn seeded_store() -> AppStore {
        let mut store = default_store();
        let session_id = "session-test-1".to_string();
        store.chat_sessions.push(crate::ChatSessionRecord {
            id: session_id.clone(),
            title: "Session".to_string(),
            created_at: "1".to_string(),
            updated_at: "2".to_string(),
            metadata: None,
            starred: false,
            archived: false,
            archived_at: None,
            deleted_at: None,
        });
        store.chat_messages.push(crate::ChatMessageRecord {
            id: "message-1".to_string(),
            session_id: session_id.clone(),
            role: "user".to_string(),
            content: "hello".to_string(),
            display_content: None,
            attachment: None,
            metadata: None,
            created_at: "1".to_string(),
        });
        store
            .session_transcript_records
            .push(crate::SessionTranscriptRecord {
                id: "trace-1".to_string(),
                session_id: session_id.clone(),
                record_type: "message".to_string(),
                role: "user".to_string(),
                content: "hello".to_string(),
                payload: None,
                created_at: 1,
            });
        store
            .session_checkpoints
            .push(crate::SessionCheckpointRecord {
                id: "checkpoint-1".to_string(),
                session_id: session_id.clone(),
                runtime_id: None,
                parent_runtime_id: None,
                source_task_id: None,
                checkpoint_type: "summary".to_string(),
                summary: "checkpoint".to_string(),
                payload: None,
                created_at: 2,
            });
        store
            .session_tool_results
            .push(crate::SessionToolResultRecord {
                id: "tool-1".to_string(),
                session_id,
                runtime_id: None,
                parent_runtime_id: None,
                source_task_id: None,
                call_id: "call-1".to_string(),
                tool_name: "bash".to_string(),
                command: Some("echo hi".to_string()),
                success: true,
                result_text: Some("hi".to_string()),
                summary_text: Some("ok".to_string()),
                prompt_text: None,
                original_chars: Some(2),
                prompt_chars: Some(2),
                truncated: false,
                payload: Some(json!({ "ok": true })),
                created_at: 3,
                updated_at: 4,
            });
        store
    }

    #[test]
    fn ensure_builtin_skills_present_refreshes_existing_builtin_body_and_forces_enabled() {
        let mut store = default_store();
        let skill = store
            .skills
            .iter_mut()
            .find(|item| item.name == "image-prompt-optimizer")
            .expect("image-prompt-optimizer builtin should exist");
        skill.body = "---\nallowedRuntimeModes: [team, image-generation]\n---\n# stale".to_string();
        skill.disabled = Some(true);

        ensure_builtin_skills_present(&mut store);

        let refreshed = store
            .skills
            .iter()
            .find(|item| item.name == "image-prompt-optimizer")
            .expect("refreshed image-prompt-optimizer should exist");
        assert!(refreshed
            .body
            .contains("allowedRuntimeModes: [team, redclaw, image-generation]"));
        assert_eq!(refreshed.disabled, Some(false));
        assert_eq!(refreshed.source_scope.as_deref(), Some("builtin"));
        assert_eq!(refreshed.is_builtin, Some(true));
    }

    #[test]
    fn ensure_builtin_skills_present_adds_tts_director_to_existing_stores() {
        let mut store = default_store();
        store.skills.retain(|item| item.name != "tts-director");

        ensure_builtin_skills_present(&mut store);

        let tts_director = store
            .skills
            .iter()
            .find(|item| item.name == "tts-director")
            .expect("tts-director builtin should be inserted");
        assert_eq!(tts_director.disabled, Some(false));
        assert_eq!(tts_director.source_scope.as_deref(), Some("builtin"));
        assert_eq!(tts_director.is_builtin, Some(true));
        assert!(tts_director.body.contains("name: tts-director"));
    }

    #[test]
    fn persist_store_moves_session_artifacts_out_of_main_snapshot() {
        let path = test_store_path("persist-split");
        let store = seeded_store();

        persist_store(&path, &store).expect("persist should succeed");

        let persisted: Value = serde_json::from_str(
            &fs::read_to_string(&path).expect("main store should be readable"),
        )
        .expect("main store should be valid json");
        assert_eq!(
            persisted["chatMessages"].as_array().map(Vec::len),
            Some(0),
            "main snapshot should no longer embed chat messages"
        );
        assert_eq!(
            persisted["sessionTranscriptRecords"]
                .as_array()
                .map(Vec::len),
            Some(0),
            "main snapshot should no longer embed transcript records"
        );
        assert_eq!(
            persisted["sessionToolResults"].as_array().map(Vec::len),
            Some(0),
            "main snapshot should no longer embed tool results"
        );

        let reloaded = load_store(&path);
        assert_eq!(reloaded.chat_messages.len(), 1);
        assert_eq!(reloaded.session_transcript_records.len(), 1);
        assert_eq!(reloaded.session_checkpoints.len(), 1);
        assert_eq!(reloaded.session_tool_results.len(), 1);

        let _ = fs::remove_dir_all(path.parent().expect("path should have parent"));
    }

    #[test]
    fn load_store_migrates_embedded_session_artifacts_from_legacy_snapshot() {
        let path = test_store_path("legacy-migrate");
        let legacy_store = seeded_store();

        let parent = path.parent().expect("path should have parent");
        fs::create_dir_all(parent).expect("parent dir should exist");
        fs::write(
            &path,
            serde_json::to_string_pretty(&legacy_store).expect("legacy store should serialize"),
        )
        .expect("legacy store should write");

        let migrated = load_store(&path);
        assert_eq!(migrated.chat_messages.len(), 1);
        assert_eq!(migrated.session_transcript_records.len(), 1);
        assert_eq!(migrated.session_checkpoints.len(), 1);
        assert_eq!(migrated.session_tool_results.len(), 1);

        let persisted: Value = serde_json::from_str(
            &fs::read_to_string(&path).expect("migrated main store should be readable"),
        )
        .expect("migrated main store should be valid json");
        assert_eq!(persisted["chatMessages"].as_array().map(Vec::len), Some(0));
        assert_eq!(
            persisted["sessionTranscriptRecords"]
                .as_array()
                .map(Vec::len),
            Some(0)
        );
        assert_eq!(
            persisted["sessionCheckpoints"].as_array().map(Vec::len),
            Some(0)
        );
        assert_eq!(
            persisted["sessionToolResults"].as_array().map(Vec::len),
            Some(0)
        );

        let artifact_dir = parent.join("session-artifacts");
        let artifact_files = fs::read_dir(&artifact_dir)
            .expect("artifact dir should exist")
            .filter_map(Result::ok)
            .count();
        assert_eq!(artifact_files, 1);

        let _ = fs::remove_dir_all(parent);
    }

    #[test]
    fn should_hydrate_subjects_only_when_subjects_and_categories_are_both_empty() {
        let mut store = default_store();
        assert!(should_hydrate_subjects(&store));

        store.categories.push(crate::SubjectCategory {
            id: "category-1".to_string(),
            name: "服装".to_string(),
            created_at: "1".to_string(),
            updated_at: "1".to_string(),
        });
        assert!(
            !should_hydrate_subjects(&store),
            "new in-memory categories must not be overwritten by workspace hydration"
        );

        store.categories.clear();
        store.subjects.push(crate::SubjectRecord {
            id: "subject-1".to_string(),
            name: "男士皮夹克".to_string(),
            category_id: None,
            description: None,
            tags: Vec::new(),
            attributes: Vec::new(),
            image_paths: Vec::new(),
            voice_path: None,
            video_path: None,
            voice_script: None,
            voice: None,
            brand_id: None,
            skus: Vec::new(),
            created_at: "1".to_string(),
            updated_at: "1".to_string(),
            absolute_image_paths: Vec::new(),
            preview_urls: Vec::new(),
            primary_preview_url: None,
            absolute_voice_path: None,
            voice_preview_url: None,
            absolute_video_path: None,
            video_preview_url: None,
        });
        assert!(
            !should_hydrate_subjects(&store),
            "new in-memory subjects must not be overwritten when category list is still empty"
        );
    }
}
