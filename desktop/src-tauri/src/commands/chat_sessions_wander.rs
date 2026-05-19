use crate::chat_binding::{bind_editor_session, EditorChatBindingRequest};
use crate::commands::chat_state::diagnostics_session_defaults;
use crate::member_skill::{attach_member_skill_metadata, detach_member_skill_metadata};
use crate::persistence::{with_store, with_store_mut};
use crate::runtime::{
    append_compact_boundary_entry, list_transcript_sessions, session_context_usage_value,
    tool_results_value_for_session, trace_value_for_session, transcript_resume_messages,
    transcript_session_meta_by_id, update_session_context_record, SessionTranscriptFileMeta,
};
use crate::session_manager::{
    create_context_session, create_session, delete_session, ensure_context_session, fork_session,
    list_context_sessions, list_sessions, remove_session_artifacts, rename_session,
    resolve_resume_target_session_id, session_detail_value, session_list_item_value,
    session_resume_value, update_metadata,
};
use crate::skills::{merge_requested_skills_into_metadata, SkillActivationSource};
use crate::*;
use base64::Engine;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};

const CHATROOM_SYNTHETIC_SESSION_PREFIX: &str = "chatroom:";
const WANDER_SYNTHESIS_SKILL: &str = "wander-synthesis";
const XHS_TITLE_SKILL: &str = "xhs-title";
const CHAT_ATTACHMENT_INLINE_PREVIEW_MAX_BYTES: u64 = 2 * 1024 * 1024;
const CHAT_ATTACHMENT_STAGE_MAX_BYTES: u64 = 512 * 1024 * 1024;
const CHAT_ATTACHMENT_PENDING_TTL_MS: u128 = 72 * 60 * 60 * 1000;
const WANDER_READY_MIN_ITEMS: usize = 3;
const WANDER_VISUAL_EXCERPT_LIMIT: usize = 6;
const WANDER_VISUAL_EXCERPT_MAX_CHARS: usize = 420;
const WANDER_NOT_ENOUGH_ITEMS_MESSAGE: &str = "可用于漫步的素材不足 3 条，请先采集更多内容。";

fn hydrate_session_file_if_needed(
    state: &State<'_, AppState>,
    session_id: &str,
) -> Result<(), String> {
    let session_id = session_id.trim();
    if session_id.is_empty() {
        return Ok(());
    }
    let needs_load = with_store(state, |store| {
        Ok(!crate::persistence::is_session_file_loaded(
            &store, session_id,
        ))
    })?;
    if !needs_load {
        return Ok(());
    }
    let entries = match crate::persistence::load_session_file(&state.store_path, session_id) {
        Ok(entries) => entries,
        Err(error) => {
            eprintln!(
                "[{}] failed to lazy-load session {}: {error}",
                app_brand_display_name(),
                session_id,
            );
            return Ok(());
        }
    };
    with_store_mut(state, |store| {
        if !crate::persistence::is_session_file_loaded(store, session_id) {
            crate::persistence::apply_session_file_entries_to_store(store, entries);
        }
        Ok(())
    })
}

fn chat_attachment_registry_path(state: &State<'_, AppState>) -> Result<PathBuf, String> {
    Ok(workspace_root(state)?
        .join(".redbox")
        .join("chat-attachments")
        .join("registry.json"))
}

fn load_chat_attachment_registry(state: &State<'_, AppState>) -> Vec<Value> {
    let Ok(path) = chat_attachment_registry_path(state) else {
        return Vec::new();
    };
    let Ok(raw) = fs::read_to_string(path) else {
        return Vec::new();
    };
    serde_json::from_str::<Value>(&raw)
        .ok()
        .and_then(|value| value.as_array().cloned())
        .unwrap_or_default()
}

fn save_chat_attachment_registry(
    state: &State<'_, AppState>,
    items: &[Value],
) -> Result<(), String> {
    let path = chat_attachment_registry_path(state)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let raw = serde_json::to_string_pretty(items).map_err(|error| error.to_string())?;
    fs::write(path, raw).map_err(|error| error.to_string())
}

fn cleanup_stale_pending_chat_attachments(state: &State<'_, AppState>) {
    let now = now_ms();
    let workspace = match workspace_root(state) {
        Ok(path) => path,
        Err(_) => return,
    };
    let mut changed = false;
    let mut items = load_chat_attachment_registry(state);
    for item in items.iter_mut() {
        let Some(object) = item.as_object_mut() else {
            continue;
        };
        let lifecycle = object
            .get("lifecycle")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if lifecycle != "pending" {
            continue;
        }
        let created_at = object
            .get("createdAtMs")
            .and_then(Value::as_u64)
            .map(u128::from)
            .unwrap_or(0);
        if created_at == 0 || now.saturating_sub(created_at) < CHAT_ATTACHMENT_PENDING_TTL_MS {
            continue;
        }
        if let Some(relative_path) = object
            .get("workspaceRelativePath")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| value.starts_with(".redbox/chat-attachments/"))
        {
            let target = workspace.join(relative_path);
            let _ = fs::remove_file(target);
        }
        object.insert("lifecycle".to_string(), json!("orphaned"));
        object.insert("updatedAtMs".to_string(), json!(now as u64));
        changed = true;
    }
    if changed {
        let _ = save_chat_attachment_registry(state, &items);
    }
}

fn register_pending_chat_attachment(state: &State<'_, AppState>, attachment: &Value) {
    let Some(attachment_id) = attachment
        .get("attachmentId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return;
    };
    let mut items = load_chat_attachment_registry(state);
    let now = now_ms();
    let record = json!({
        "attachmentId": attachment_id,
        "lifecycle": "pending",
        "createdAtMs": now as u64,
        "updatedAtMs": now as u64,
        "name": attachment.get("name").cloned().unwrap_or(Value::Null),
        "kind": attachment.get("kind").cloned().unwrap_or(Value::Null),
        "workspaceRelativePath": attachment.get("workspaceRelativePath").cloned().unwrap_or(Value::Null),
        "absolutePath": attachment.get("absolutePath").cloned().unwrap_or(Value::Null),
        "mediaAssetId": attachment.get("mediaAssetId").cloned().unwrap_or(Value::Null),
    });
    if let Some(existing) = items.iter_mut().find(|item| {
        item.get("attachmentId")
            .and_then(Value::as_str)
            .map(str::trim)
            == Some(attachment_id)
    }) {
        *existing = record;
    } else {
        items.push(record);
    }
    let _ = save_chat_attachment_registry(state, &items);
}

fn attachment_ids_from_payload_value(value: &Value) -> Vec<String> {
    let mut ids = Vec::<String>::new();
    let values: Vec<&Value> = if let Some(array) = value.as_array() {
        array.iter().collect()
    } else {
        vec![value]
    };
    for item in values {
        if let Some(id) = item
            .get("attachmentId")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            ids.push(id.to_string());
        }
    }
    ids.sort();
    ids.dedup();
    ids
}

pub(crate) fn commit_chat_attachments_state(
    state: &State<'_, AppState>,
    attachments: Option<&Value>,
    session_id: Option<&str>,
) -> Result<(), String> {
    let Some(attachments) = attachments else {
        return Ok(());
    };
    let ids = attachment_ids_from_payload_value(attachments);
    if ids.is_empty() {
        return Ok(());
    }
    let mut changed = false;
    let now = now_ms();
    let mut items = load_chat_attachment_registry(state);
    for item in items.iter_mut() {
        let Some(object) = item.as_object_mut() else {
            continue;
        };
        let id = object
            .get("attachmentId")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or_default();
        if !ids.iter().any(|candidate| candidate == id) {
            continue;
        }
        object.insert("lifecycle".to_string(), json!("committed"));
        object.insert("updatedAtMs".to_string(), json!(now as u64));
        if let Some(session_id) = session_id {
            object.insert("sessionId".to_string(), json!(session_id));
        }
        changed = true;
    }
    if changed {
        save_chat_attachment_registry(state, &items)?;
    }
    Ok(())
}

fn discard_chat_attachments_state(
    state: &State<'_, AppState>,
    attachments: Option<&Value>,
) -> Result<(), String> {
    let Some(attachments) = attachments else {
        return Ok(());
    };
    let ids = attachment_ids_from_payload_value(attachments);
    if ids.is_empty() {
        return Ok(());
    }
    let workspace = workspace_root(state)?;
    let mut changed = false;
    let now = now_ms();
    let mut items = load_chat_attachment_registry(state);
    for item in items.iter_mut() {
        let Some(object) = item.as_object_mut() else {
            continue;
        };
        let id = object
            .get("attachmentId")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or_default();
        if !ids.iter().any(|candidate| candidate == id) {
            continue;
        }
        let lifecycle = object
            .get("lifecycle")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if lifecycle != "pending" {
            continue;
        }
        if let Some(relative_path) = object
            .get("workspaceRelativePath")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| value.starts_with(".redbox/chat-attachments/"))
        {
            let _ = fs::remove_file(workspace.join(relative_path));
        }
        object.insert("lifecycle".to_string(), json!("deleted"));
        object.insert("updatedAtMs".to_string(), json!(now as u64));
        changed = true;
    }
    if changed {
        save_chat_attachment_registry(state, &items)?;
    }
    Ok(())
}

fn attachment_capabilities(
    kind: &str,
    has_workspace_path: bool,
    direct_upload_eligible: bool,
) -> Value {
    let is_text = kind == "text";
    let is_document = kind == "document";
    let is_image = kind == "image";
    let is_audio = kind == "audio";
    let is_video = kind == "video";
    json!({
        "directInput": direct_upload_eligible || matches!(kind, "image" | "audio" | "video" | "text" | "document"),
        "workspaceRead": has_workspace_path,
        "textExtract": has_workspace_path && (is_text || is_document),
        "documentExtract": has_workspace_path && is_document,
        "imageVision": is_image,
        "audioTranscribe": has_workspace_path && is_audio,
        "videoAnalyze": has_workspace_path && is_video,
        "videoEdit": has_workspace_path && is_video,
    })
}

fn attachment_delivery_mode(kind: &str, has_workspace_path: bool) -> &'static str {
    if !has_workspace_path {
        return "unsupported";
    }
    match kind {
        "audio" | "video" | "image" => "media-tool",
        "document" => "document-tool",
        _ => "workspace-tool",
    }
}

fn attachment_can_use_original_media_path(kind: &str) -> bool {
    matches!(kind, "audio" | "video")
}

fn chat_attachment_value_for_path(
    app: &AppHandle,
    state: &State<'_, AppState>,
    original_path: &Path,
    effective_path: &Path,
    file_size: u64,
    staged_relative_path: Option<String>,
    media_asset: Option<&MediaAssetRecord>,
) -> Value {
    let (mime_type, kind, direct_upload_eligible) = guess_mime_and_kind(original_path);
    let thumbnail_data_url = if kind == "image" {
        inline_image_thumbnail_data_url(effective_path, &mime_type, file_size)
    } else if kind == "video" {
        ensure_video_thumbnail_for_path(Some(app), state, effective_path)
    } else {
        None
    };
    let workspace_relative_path = media_asset
        .and_then(|asset| asset.relative_path.as_ref())
        .map(|relative_path| format!("media/{relative_path}"))
        .or(staged_relative_path);
    let external_media_tool_path =
        if workspace_relative_path.is_none() && attachment_can_use_original_media_path(&kind) {
            Some(effective_path.display().to_string())
        } else {
            None
        };
    let has_tool_path = workspace_relative_path.is_some() || external_media_tool_path.is_some();
    let delivery_mode = attachment_delivery_mode(&kind, has_tool_path);
    let tool_path = workspace_relative_path.clone().or(external_media_tool_path);
    json!({
        "attachmentId": make_id("attachment"),
        "type": "uploaded-file",
        "name": original_path.file_name().and_then(|value| value.to_str()).unwrap_or("attachment"),
        "ext": original_path.extension().and_then(|value| value.to_str()).unwrap_or(""),
        "size": file_size,
        "thumbnailDataUrl": thumbnail_data_url,
        "thumbnailUrl": thumbnail_data_url,
        "workspaceRelativePath": workspace_relative_path.clone(),
        "toolPath": tool_path.clone(),
        "absolutePath": effective_path.display().to_string(),
        "originalAbsolutePath": original_path.display().to_string(),
        "localUrl": file_url_for_path(effective_path),
        "kind": kind,
        "mimeType": mime_type,
        "storageMode": if effective_path != original_path { "staged" } else { "absolute" },
        "directUploadEligible": direct_upload_eligible,
        "processingStrategy": delivery_mode,
        "intakeStatus": if has_tool_path { "ready" } else { "unsupported" },
        "attachmentLifecycle": "pending",
        "capabilities": attachment_capabilities(&kind, has_tool_path, direct_upload_eligible),
        "deliveryPlan": {
            "mode": delivery_mode,
            "toolPath": tool_path,
            "requiresTool": delivery_mode != "unsupported",
            "reason": if delivery_mode == "unsupported" { "文件未能进入工作区暂存区，当前工具无法稳定读取。" } else { "" },
        },
        "summary": original_path.display().to_string(),
        "requiresMultimodal": kind == "image" || kind == "audio" || kind == "video",
        "mediaAssetId": media_asset.map(|asset| asset.id.clone()),
        "mediaRelativePath": media_asset.and_then(|asset| asset.relative_path.clone()),
        "mediaSource": media_asset.map(|asset| asset.source.clone()),
    })
}

fn lightweight_image_attachment_value_for_path(path: &Path, file_size: u64) -> Value {
    let (mime_type, kind, direct_upload_eligible) = guess_mime_and_kind(path);
    let thumbnail_data_url = inline_image_thumbnail_data_url(path, &mime_type, file_size);
    json!({
        "attachmentId": make_id("attachment"),
        "type": "uploaded-file",
        "name": path.file_name().and_then(|value| value.to_str()).unwrap_or("attachment"),
        "ext": path.extension().and_then(|value| value.to_str()).unwrap_or(""),
        "size": file_size,
        "thumbnailDataUrl": thumbnail_data_url,
        "thumbnailUrl": thumbnail_data_url,
        "workspaceRelativePath": Value::Null,
        "toolPath": Value::Null,
        "absolutePath": path.display().to_string(),
        "originalAbsolutePath": path.display().to_string(),
        "localUrl": file_url_for_path(path),
        "kind": kind,
        "mimeType": mime_type,
        "storageMode": "absolute",
        "directUploadEligible": direct_upload_eligible,
        "processingStrategy": "direct-input",
        "deliveryMode": "direct-input",
        "intakeStatus": "ready",
        "attachmentLifecycle": "pending",
        "capabilities": attachment_capabilities("image", false, true),
        "deliveryPlan": {
            "mode": "direct-input",
            "toolPath": Value::Null,
            "requiresTool": false,
            "reason": "",
        },
        "summary": path.display().to_string(),
        "requiresMultimodal": true,
        "mediaAssetId": Value::Null,
        "mediaRelativePath": Value::Null,
        "mediaSource": Value::Null,
    })
}

fn spawn_chat_attachment_image_import(app: &AppHandle, path: &Path) {
    let app = app.clone();
    let path = path.to_path_buf();
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        if let Err(error) =
            crate::knowledge::import_chat_attachment_image(Some(&app), &state, &path)
        {
            append_debug_trace_state(
                &state,
                format!(
                    "[chat-attachment] background image import failed path={} error={}",
                    path.display(),
                    error
                ),
            );
        }
    });
}

fn merge_session_metadata_fields(
    store: &mut AppStore,
    session_id: &str,
    incoming: Option<&Value>,
) -> Option<ChatSessionRecord> {
    let incoming = incoming?.as_object()?;
    let session = store
        .chat_sessions
        .iter_mut()
        .find(|item| item.id == session_id)?;
    let mut metadata = session
        .metadata
        .clone()
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    for (key, value) in incoming {
        metadata.insert(key.clone(), value.clone());
    }
    session.metadata = Some(Value::Object(metadata));
    session.updated_at = now_iso();
    Some(session.clone())
}

fn inline_image_thumbnail_data_url(path: &Path, mime_type: &str, file_size: u64) -> Option<String> {
    if !mime_type.starts_with("image/")
        || file_size == 0
        || file_size > CHAT_ATTACHMENT_INLINE_PREVIEW_MAX_BYTES
    {
        return None;
    }
    let bytes = fs::read(path).ok()?;
    Some(format!(
        "data:{mime_type};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}

fn sanitize_chat_attachment_name(name: &str) -> String {
    let sanitized = name
        .trim()
        .chars()
        .map(|ch| match ch {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            _ => ch,
        })
        .collect::<String>()
        .trim()
        .to_string();
    if sanitized.is_empty() {
        "attachment".to_string()
    } else {
        sanitized
    }
}

fn stage_chat_attachment_for_workspace(
    state: &State<'_, AppState>,
    original_path: &Path,
    file_size: u64,
) -> Option<(PathBuf, String)> {
    if file_size == 0 || file_size > CHAT_ATTACHMENT_STAGE_MAX_BYTES {
        return None;
    }
    let workspace = workspace_root(state).ok()?;
    if let Ok(relative) = original_path.strip_prefix(&workspace) {
        let normalized = relative.display().to_string().replace('\\', "/");
        if !normalized.trim().is_empty() {
            return Some((original_path.to_path_buf(), normalized));
        }
    }

    let stage_root = workspace.join(".redbox").join("chat-attachments");
    fs::create_dir_all(&stage_root).ok()?;
    let file_name = original_path
        .file_name()
        .and_then(|value| value.to_str())
        .map(sanitize_chat_attachment_name)
        .unwrap_or_else(|| "attachment".to_string());
    let staged_name = format!("{}-{}", now_ms(), file_name);
    let staged_path = stage_root.join(staged_name);
    if fs::hard_link(original_path, &staged_path).is_err() {
        fs::copy(original_path, &staged_path).ok()?;
    }
    let relative = staged_path
        .strip_prefix(&workspace)
        .ok()?
        .display()
        .to_string()
        .replace('\\', "/");
    Some((staged_path, relative))
}

fn create_chat_attachment_for_path(
    app: &AppHandle,
    state: &State<'_, AppState>,
    path: &Path,
) -> Result<Value, String> {
    cleanup_stale_pending_chat_attachments(state);
    if !path.is_file() {
        return Err(format!("不是可发送的文件: {}", path.display()));
    }
    let metadata = fs::metadata(path).map_err(|error| error.to_string())?;
    let (_, attachment_kind, _) = guess_mime_and_kind(path);
    if attachment_kind == "image" {
        let attachment = lightweight_image_attachment_value_for_path(path, metadata.len());
        register_pending_chat_attachment(state, &attachment);
        spawn_chat_attachment_image_import(app, path);
        return Ok(attachment);
    }
    let imported_media_asset: Option<MediaAssetRecord> = None;
    let staged = if imported_media_asset.is_some() {
        None
    } else if attachment_can_use_original_media_path(&attachment_kind) {
        None
    } else {
        stage_chat_attachment_for_workspace(state, path, metadata.len())
    };
    if imported_media_asset.is_none()
        && staged.is_none()
        && !attachment_can_use_original_media_path(&attachment_kind)
    {
        if metadata.len() == 0 {
            return Err("文件为空，无法作为聊天附件发送。".to_string());
        }
        if metadata.len() > CHAT_ATTACHMENT_STAGE_MAX_BYTES {
            return Err(format!(
                "文件超过 {} MB，当前无法稳定暂存给 AI 工具处理。",
                CHAT_ATTACHMENT_STAGE_MAX_BYTES / 1024 / 1024
            ));
        }
        return Err("文件未能进入工作区暂存区，当前无法稳定交给 AI 工具处理。".to_string());
    }
    let imported_absolute_path = imported_media_asset
        .as_ref()
        .and_then(|asset| asset.absolute_path.as_ref())
        .map(PathBuf::from);
    let effective_path = imported_absolute_path
        .as_deref()
        .or_else(|| staged.as_ref().map(|(absolute, _)| absolute.as_path()))
        .unwrap_or(path);
    let attachment = chat_attachment_value_for_path(
        app,
        state,
        path,
        effective_path,
        metadata.len(),
        staged.as_ref().map(|(_, relative)| relative.clone()),
        imported_media_asset.as_ref(),
    );
    register_pending_chat_attachment(state, &attachment);
    Ok(attachment)
}

fn xorshift64(mut seed: u64) -> u64 {
    if seed == 0 {
        seed = 0x9E37_79B9_7F4A_7C15;
    }
    seed ^= seed << 13;
    seed ^= seed >> 7;
    seed ^= seed << 17;
    seed
}

fn shuffle_wander_items(items: &mut [Value], seed: u64) {
    if items.len() <= 1 {
        return;
    }
    let mut state = seed;
    for index in (1..items.len()).rev() {
        state = xorshift64(state);
        let swap_index = (state as usize) % (index + 1);
        items.swap(index, swap_index);
    }
}

fn wander_shuffle_seed(items: &[Value]) -> u64 {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos() as u64)
        .unwrap_or_else(|_| now_ms() as u64);
    let mut seed = nanos
        ^ ((std::process::id() as u64) << 17)
        ^ ((items.len() as u64) << 33)
        ^ (now_ms() as u64).rotate_left(11);
    for item in items.iter().take(8) {
        if let Some(id) = item.get("id").and_then(Value::as_str) {
            for byte in id.as_bytes() {
                seed ^= (*byte as u64).wrapping_mul(0x9E37_79B9);
                seed = xorshift64(seed);
            }
        }
    }
    xorshift64(seed)
}

fn collect_wander_candidate_items(store: &AppStore) -> Vec<Value> {
    let mut items = Vec::new();
    for note in &store.knowledge_notes {
        items.push(wander_item_from_note(note));
    }
    for video in &store.youtube_videos {
        items.push(wander_item_from_youtube(video));
    }
    for source in &store.document_sources {
        items.push(wander_item_from_doc(source));
    }
    items
}

fn wander_item_source_id(item: &Value) -> String {
    item.get("id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or_default()
        .to_string()
}

fn classify_wander_incomplete_visual_status(statuses: &[String]) -> String {
    if statuses
        .iter()
        .any(|status| matches!(status.as_str(), "failed" | "metadata_only"))
    {
        "failed".to_string()
    } else {
        "indexing".to_string()
    }
}

fn load_wander_index_payload(
    state: &State<'_, AppState>,
    source_id: &str,
) -> Result<(bool, String, Vec<Value>), String> {
    let source_id = source_id.trim();
    if source_id.is_empty() {
        return Ok((false, "not_indexed".to_string(), Vec::new()));
    }
    if let Err(error) = crate::knowledge_index::schema::ensure_catalog_ready(state) {
        eprintln!(
            "[wander] knowledge index unavailable, continuing without visual excerpts: {error}"
        );
        return Ok((true, "not_indexed".to_string(), Vec::new()));
    }
    let conn = match crate::knowledge_index::open_catalog_connection(state) {
        Ok(conn) => conn,
        Err(error) => {
            eprintln!("[wander] failed to open knowledge index, continuing without visual excerpts: {error}");
            return Ok((true, "not_indexed".to_string(), Vec::new()));
        }
    };
    let block_count = conn
        .query_row(
            "SELECT COUNT(*) FROM knowledge_document_blocks WHERE source_id = ?1",
            rusqlite::params![source_id],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| error.to_string())?;

    let mut status_stmt = conn
        .prepare(
            r#"
            SELECT DISTINCT lower(status)
            FROM knowledge_visual_units
            WHERE source_id = ?1
              AND lower(status) <> 'indexed'
            ORDER BY lower(status) ASC
            "#,
        )
        .map_err(|error| error.to_string())?;
    let incomplete_statuses = status_stmt
        .query_map(rusqlite::params![source_id], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    let status = if !incomplete_statuses.is_empty() {
        classify_wander_incomplete_visual_status(&incomplete_statuses)
    } else if block_count <= 0 {
        "not_indexed".to_string()
    } else {
        "ready".to_string()
    };

    let mut block_stmt = conn
        .prepare(
            r#"
            SELECT block_id, relative_path, page, text, visual_unit_id
            FROM knowledge_document_blocks
            WHERE source_id = ?1
              AND (
                content_origin IN ('visual_llm', 'ocr')
                OR block_type LIKE 'image.%'
                OR visual_unit_id IS NOT NULL
              )
              AND trim(text) <> ''
            ORDER BY relative_path ASC, page ASC, block_index ASC
            LIMIT ?2
            "#,
        )
        .map_err(|error| error.to_string())?;
    let blocks = block_stmt
        .query_map(
            rusqlite::params![source_id, WANDER_VISUAL_EXCERPT_LIMIT as i64],
            |row| {
                let text: String = row.get(3)?;
                Ok(json!({
                    "blockId": row.get::<_, String>(0)?,
                    "path": row.get::<_, String>(1)?,
                    "page": row.get::<_, Option<i64>>(2)?,
                    "text": truncate_chars(&normalize_wander_bundle_text(&text, WANDER_VISUAL_EXCERPT_MAX_CHARS), WANDER_VISUAL_EXCERPT_MAX_CHARS),
                    "visualUnitId": row.get::<_, Option<String>>(4)?,
                }))
            },
        )
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;

    Ok((true, status, blocks))
}

fn enrich_wander_item_for_index(
    state: &State<'_, AppState>,
    mut item: Value,
) -> Result<Value, String> {
    let source_id = wander_item_source_id(&item);
    let (ready, status, visual_blocks) = load_wander_index_payload(state, &source_id)?;
    if let Some(object) = item.as_object_mut() {
        object.insert("readyForWander".to_string(), json!(ready));
        object.insert("wanderIndexStatus".to_string(), json!(status.clone()));
        let meta_entry = object.entry("meta").or_insert_with(|| json!({}));
        if !meta_entry.is_object() {
            *meta_entry = json!({});
        }
        if let Some(meta) = meta_entry.as_object_mut() {
            meta.insert("readyForWander".to_string(), json!(ready));
            meta.insert("wanderIndexStatus".to_string(), json!(status));
            meta.insert("wanderVisualBlocks".to_string(), json!(visual_blocks));
        }
    }
    Ok(item)
}

fn enrich_wander_items_for_index(
    state: &State<'_, AppState>,
    items: Vec<Value>,
) -> Result<Vec<Value>, String> {
    items
        .into_iter()
        .map(|item| enrich_wander_item_for_index(state, item))
        .collect()
}

fn enrich_wander_items_with_optional_index(
    state: &State<'_, AppState>,
    items: Vec<Value>,
) -> Result<Vec<Value>, String> {
    enrich_wander_items_for_index(state, items)
}

fn recent_wander_excluded_ids(store: &AppStore, recent_limit: usize) -> HashSet<String> {
    let mut history = if store.wander_history.is_empty() {
        rebuild_wander_history_from_sessions(store)
    } else {
        store.wander_history.clone()
    };
    history.sort_by(|left, right| right.created_at.cmp(&left.created_at));
    history
        .into_iter()
        .take(recent_limit)
        .filter_map(|record| serde_json::from_str::<Vec<Value>>(&record.items).ok())
        .flat_map(|items| items.into_iter())
        .filter_map(|item| {
            item.get("id")
                .and_then(Value::as_str)
                .map(|id| id.trim().to_string())
        })
        .filter(|id| !id.is_empty())
        .collect()
}

fn pick_random_wander_items(
    mut items: Vec<Value>,
    count: usize,
    excluded_ids: &HashSet<String>,
) -> Vec<Value> {
    items.sort_by_key(|item| {
        item.get("id")
            .and_then(|value| value.as_str())
            .unwrap_or("")
            .to_string()
    });

    let mut eligible = Vec::new();
    let mut fallback = Vec::new();
    for item in items {
        let id = item
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string();
        if id.is_empty() {
            continue;
        }
        if excluded_ids.contains(&id) {
            fallback.push(item);
        } else {
            eligible.push(item);
        }
    }

    if eligible.is_empty() && fallback.is_empty() {
        return Vec::new();
    }

    let target_count = count.max(1);
    let seed = wander_shuffle_seed(&eligible);
    shuffle_wander_items(&mut eligible, seed);
    let mut selected = eligible.into_iter().take(target_count).collect::<Vec<_>>();
    if selected.len() < target_count {
        let fallback_seed = wander_shuffle_seed(&fallback);
        shuffle_wander_items(&mut fallback, fallback_seed);
        selected.extend(fallback.into_iter().take(target_count - selected.len()));
    }
    selected
}

fn normalize_guided_text(raw: &str) -> String {
    raw.trim()
        .to_lowercase()
        .chars()
        .map(|ch| {
            if ch.is_alphanumeric() || ('\u{4e00}'..='\u{9fff}').contains(&ch) {
                ch
            } else {
                ' '
            }
        })
        .collect::<String>()
}

fn push_unique_guided_term(terms: &mut Vec<String>, term: String) {
    let normalized = term.trim().to_string();
    if normalized.chars().count() < 2 || terms.iter().any(|item| item == &normalized) {
        return;
    }
    terms.push(normalized);
}

fn extract_guided_terms(parts: &[String]) -> Vec<String> {
    let mut terms = Vec::new();
    for part in parts {
        let normalized = normalize_guided_text(part);
        for token in normalized.split_whitespace() {
            if token
                .chars()
                .any(|ch| ('\u{4e00}'..='\u{9fff}').contains(&ch))
            {
                let chars = token.chars().collect::<Vec<_>>();
                if chars.len() >= 2 {
                    push_unique_guided_term(&mut terms, token.to_string());
                }
                for size in [2usize, 3usize] {
                    if chars.len() < size {
                        continue;
                    }
                    for index in 0..=(chars.len() - size) {
                        push_unique_guided_term(
                            &mut terms,
                            chars[index..index + size].iter().collect::<String>(),
                        );
                        if terms.len() >= 80 {
                            return terms;
                        }
                    }
                }
            } else if token.len() >= 2 {
                push_unique_guided_term(&mut terms, token.to_string());
            }
            if terms.len() >= 80 {
                return terms;
            }
        }
    }
    terms
}

fn wander_item_id(item: &Value) -> String {
    item.get("id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string()
}

fn wander_guided_score(item: &Value, terms: &[String], full_query: &str) -> f64 {
    if terms.is_empty() && full_query.trim().is_empty() {
        return 0.0;
    }
    let title = normalize_guided_text(item.get("title").and_then(Value::as_str).unwrap_or(""));
    let content = normalize_guided_text(item.get("content").and_then(Value::as_str).unwrap_or(""));
    let meta = item.get("meta").cloned().unwrap_or_else(|| json!({}));
    let meta_text = normalize_guided_text(&meta.to_string());
    let mut score = 0.0;
    let normalized_query = normalize_guided_text(full_query);
    let compact_query = normalized_query
        .split_whitespace()
        .collect::<Vec<_>>()
        .join("");
    if compact_query.chars().count() >= 3 {
        if title.replace(' ', "").contains(&compact_query) {
            score += 10.0;
        }
        if content.replace(' ', "").contains(&compact_query) {
            score += 5.0;
        }
    }
    for term in terms {
        if title.contains(term) {
            score += 4.0;
        }
        if content.contains(term) {
            score += 2.0;
        }
        if meta_text.contains(term) {
            score += 0.75;
        }
    }
    score
}

fn pick_weighted_guided_items(scored: &mut [(Value, f64)], count: usize, seed: u64) -> Vec<Value> {
    if scored.is_empty() || count == 0 {
        return Vec::new();
    }
    scored.sort_by(|left, right| {
        right
            .1
            .partial_cmp(&left.1)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| wander_item_id(&left.0).cmp(&wander_item_id(&right.0)))
    });
    let mut pool = scored
        .iter()
        .take(30)
        .map(|(item, score)| (item.clone(), score.max(0.1)))
        .collect::<Vec<_>>();
    let mut picked = Vec::new();
    let mut state = xorshift64(seed);
    while !pool.is_empty() && picked.len() < count {
        state = xorshift64(state);
        let total = pool.iter().map(|(_, score)| *score).sum::<f64>().max(0.1);
        let mut cursor = (state as f64 / u64::MAX as f64) * total;
        let mut picked_index = 0usize;
        for (index, (_, score)) in pool.iter().enumerate() {
            if cursor <= *score {
                picked_index = index;
                break;
            }
            cursor -= *score;
        }
        picked.push(pool.remove(picked_index).0);
    }
    picked
}

fn compose_guided_wander_items_with_candidates(
    store: &AppStore,
    payload: &Value,
    candidate_items: Vec<Value>,
    readiness_warning: Option<String>,
) -> Value {
    let topic = payload_string(payload, "topic").unwrap_or_default();
    let seed_text = payload_string(payload, "seedText").unwrap_or_default();
    let target_count = payload_field(payload, "targetCount")
        .and_then(Value::as_u64)
        .map(|value| value as usize)
        .unwrap_or(3)
        .clamp(1, 6);
    let anchor_item = payload
        .get("anchorItem")
        .filter(|value| value.is_object())
        .cloned();
    let anchor_id = anchor_item
        .as_ref()
        .map(wander_item_id)
        .filter(|id| !id.is_empty());
    let mut query_parts = vec![topic.clone(), seed_text.clone()];
    if let Some(anchor) = anchor_item.as_ref() {
        query_parts.push(
            anchor
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
        );
        query_parts.push(
            anchor
                .get("content")
                .and_then(Value::as_str)
                .unwrap_or("")
                .chars()
                .take(400)
                .collect::<String>(),
        );
    }
    let full_query = query_parts
        .iter()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    let terms = extract_guided_terms(&query_parts);
    let excluded_ids = recent_wander_excluded_ids(store, 5);
    let mut selected = Vec::new();
    if let Some(anchor) = anchor_item {
        selected.push(anchor);
    }
    let needed = target_count.saturating_sub(selected.len());
    let scored = candidate_items
        .into_iter()
        .filter(|item| {
            let id = wander_item_id(item);
            !id.is_empty()
                && anchor_id
                    .as_ref()
                    .map(|anchor| anchor != &id)
                    .unwrap_or(true)
                && !excluded_ids.contains(&id)
        })
        .map(|item| {
            let score = wander_guided_score(&item, &terms, &full_query);
            (item, score)
        })
        .collect::<Vec<_>>();
    let minimum_score = if anchor_id.is_some() { 0.75 } else { 4.0 };
    let mut strong_scored = scored
        .iter()
        .filter(|(_, score)| *score >= minimum_score)
        .cloned()
        .collect::<Vec<_>>();
    let seed_items = scored
        .iter()
        .map(|(item, _)| item.clone())
        .collect::<Vec<_>>();
    let mut picked =
        pick_weighted_guided_items(&mut strong_scored, needed, wander_shuffle_seed(&seed_items));
    if picked.len() < needed {
        let picked_ids = picked.iter().map(wander_item_id).collect::<HashSet<_>>();
        let mut relaxed_scored = scored
            .iter()
            .filter(|(item, score)| *score > 0.0 && !picked_ids.contains(&wander_item_id(item)))
            .cloned()
            .collect::<Vec<_>>();
        let relaxed_seed_items = relaxed_scored
            .iter()
            .map(|(item, _)| item.clone())
            .collect::<Vec<_>>();
        let mut relaxed = pick_weighted_guided_items(
            &mut relaxed_scored,
            needed - picked.len(),
            wander_shuffle_seed(&relaxed_seed_items),
        );
        picked.append(&mut relaxed);
    }
    selected.append(&mut picked);
    let warning = readiness_warning.or_else(|| {
        if selected.len() < target_count {
            Some(format!(
                "只找到 {} 条方向相关素材，请换一个主题或选择信息更完整的锚点笔记。",
                selected.len()
            ))
        } else {
            None
        }
    });
    json!({
        "items": selected,
        "warning": warning,
        "query": full_query,
        "candidateCount": scored.len(),
    })
}

#[cfg(test)]
fn compose_guided_wander_items(store: &AppStore, payload: &Value) -> Value {
    compose_guided_wander_items_with_candidates(
        store,
        payload,
        collect_wander_candidate_items(store),
        None,
    )
}

fn compose_guided_wander_items_for_state(
    state: &State<'_, AppState>,
    store: &AppStore,
    payload: &Value,
) -> Result<Value, String> {
    let mut payload = payload.clone();
    let warning = None::<String>;
    if let Some(anchor_item) = payload
        .get("anchorItem")
        .filter(|value| value.is_object())
        .cloned()
    {
        let enriched_anchor = enrich_wander_item_for_index(state, anchor_item)?;
        if let Some(object) = payload.as_object_mut() {
            object.insert("anchorItem".to_string(), enriched_anchor);
        }
    }
    let candidates =
        enrich_wander_items_with_optional_index(state, collect_wander_candidate_items(store))?;
    Ok(compose_guided_wander_items_with_candidates(
        store, &payload, candidates, warning,
    ))
}

fn parse_wander_json_payload(payload: &str) -> Option<Value> {
    let trimmed = payload.trim();
    if trimmed.is_empty() {
        return None;
    }
    let strip_code_fence = |text: &str| {
        text.trim()
            .trim_start_matches("```json")
            .trim_start_matches("```")
            .trim_end_matches("```")
            .trim()
            .to_string()
    };
    let try_parse = |text: &str| serde_json::from_str::<Value>(text).ok();
    if let Some(value) = try_parse(trimmed) {
        return Some(value);
    }
    let without_fence = strip_code_fence(trimmed);
    if let Some(value) = try_parse(&without_fence) {
        return Some(value);
    }
    let first_brace = without_fence.find('{')?;
    let last_brace = without_fence.rfind('}')?;
    if last_brace <= first_brace {
        return None;
    }
    try_parse(&without_fence[first_brace..=last_brace])
}

fn normalize_wander_connections(raw: Option<&Value>) -> Vec<Value> {
    let Some(items) = raw.and_then(Value::as_array) else {
        return vec![json!(1)];
    };
    let mut normalized = Vec::<i64>::new();
    for item in items {
        let Some(value) = item
            .as_i64()
            .or_else(|| item.as_u64().map(|v| v as i64))
            .or_else(|| {
                item.as_str()
                    .and_then(|text| text.trim().parse::<i64>().ok())
            })
        else {
            continue;
        };
        let bounded = value.clamp(1, 3);
        if !normalized.contains(&bounded) {
            normalized.push(bounded);
        }
    }
    if normalized.is_empty() {
        normalized.push(1);
    }
    normalized.into_iter().map(Value::from).collect()
}

fn normalize_wander_direction_frame(raw: &Value) -> Value {
    let payload = raw
        .get("direction_frame")
        .or_else(|| raw.get("directionFrame"))
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let read_field = |snake: &str, camel: &str| {
        payload
            .get(snake)
            .or_else(|| payload.get(camel))
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string()
    };
    json!({
        "target_reader": read_field("target_reader", "targetReader"),
        "core_tension": read_field("core_tension", "coreTension"),
        "angle": read_field("angle", "angle"),
        "material_entry": read_field("material_entry", "materialEntry"),
    })
}

fn synthesize_wander_content_direction(frame: &Value) -> Option<String> {
    let read_field = |key: &str| {
        frame
            .get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToString::to_string)
    };
    let target_reader = read_field("target_reader")?;
    let core_tension = read_field("core_tension")?;
    let angle = read_field("angle")?;
    let material_entry = read_field("material_entry")?;
    Some(format!(
        "面向{target_reader}，围绕「{core_tension}」展开；叙事角度是{angle}；素材切口是{material_entry}。"
    ))
}

fn normalize_wander_option(raw: &Value) -> Value {
    let topic = raw.get("topic").and_then(Value::as_object);
    let title = topic
        .and_then(|value| value.get("title"))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            raw.get("title")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
        })
        .unwrap_or("")
        .trim()
        .to_string();
    let direction_frame = normalize_wander_direction_frame(raw);
    let content_direction = raw
        .get("content_direction")
        .and_then(Value::as_str)
        .or_else(|| raw.get("direction").and_then(Value::as_str))
        .or_else(|| raw.get("contentDirection").and_then(Value::as_str))
        .filter(|value| !value.trim().is_empty())
        .map(|value| value.trim().to_string())
        .or_else(|| synthesize_wander_content_direction(&direction_frame))
        .unwrap_or_default();
    json!({
        "content_direction": content_direction,
        "direction_frame": direction_frame,
        "topic": {
            "title": title,
            "connections": normalize_wander_connections(
                topic.and_then(|value| value.get("connections")).or_else(|| raw.get("connections"))
            )
        }
    })
}

fn repair_embedded_wander_result(raw: Value) -> Value {
    let Some(content_direction) = raw.get("content_direction").and_then(Value::as_str) else {
        return raw;
    };
    let Some(embedded) = parse_wander_json_payload(content_direction) else {
        return raw;
    };
    if embedded.get("topic").is_none() {
        return raw;
    }
    let merged_thinking = raw
        .get("thinking_process")
        .cloned()
        .filter(|value| {
            value
                .as_array()
                .map(|items| !items.is_empty())
                .unwrap_or(false)
        })
        .or_else(|| embedded.get("thinking_process").cloned())
        .unwrap_or_else(|| json!([]));
    json!({
        "content_direction": embedded.get("content_direction").cloned().or_else(|| raw.get("content_direction").cloned()).unwrap_or_else(|| json!("")),
        "thinking_process": merged_thinking,
        "direction_frame": embedded
            .get("direction_frame")
            .cloned()
            .or_else(|| embedded.get("directionFrame").cloned())
            .or_else(|| raw.get("direction_frame").cloned())
            .or_else(|| raw.get("directionFrame").cloned())
            .unwrap_or_else(|| json!({})),
        "topic": embedded.get("topic").cloned().or_else(|| raw.get("topic").cloned()).unwrap_or_else(|| json!({
            "title": "",
            "connections": [1]
        })),
        "options": raw.get("options").cloned().or_else(|| embedded.get("options").cloned()),
        "selected_index": raw.get("selected_index").cloned().or_else(|| embedded.get("selected_index").cloned()).unwrap_or_else(|| json!(0))
    })
}

fn normalize_wander_result(raw: Value, multi_choice: bool) -> Value {
    let repaired = repair_embedded_wander_result(raw);
    let thinking_process = repaired
        .get("thinking_process")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str())
                .map(|item| item.trim())
                .filter(|item| !item.is_empty())
                .take(6)
                .map(|item| Value::from(item.to_string()))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    if multi_choice {
        let candidate_options = repaired
            .get("options")
            .and_then(Value::as_array)
            .cloned()
            .or_else(|| repaired.get("choices").and_then(Value::as_array).cloned())
            .unwrap_or_default();
        let mut normalized_options = candidate_options
            .iter()
            .map(normalize_wander_option)
            .collect::<Vec<_>>();
        if normalized_options.is_empty() {
            normalized_options.push(normalize_wander_option(&repaired));
        }
        normalized_options.truncate(3);
        let first = normalized_options
            .first()
            .cloned()
            .unwrap_or_else(|| normalize_wander_option(&repaired));
        return json!({
            "thinking_process": thinking_process,
            "options": normalized_options,
            "content_direction": first.get("content_direction").cloned().unwrap_or_else(|| json!("")),
            "direction_frame": first.get("direction_frame").cloned().unwrap_or_else(|| json!({})),
            "topic": first.get("topic").cloned().unwrap_or_else(|| json!({
                "title": "",
                "connections": [1]
            })),
            "selected_index": 0
        });
    }

    let single = normalize_wander_option(&repaired);
    json!({
        "content_direction": single.get("content_direction").cloned().unwrap_or_else(|| json!("")),
        "thinking_process": thinking_process,
        "direction_frame": single.get("direction_frame").cloned().unwrap_or_else(|| json!({})),
        "topic": single.get("topic").cloned().unwrap_or_else(|| json!({
            "title": "",
            "connections": [1]
        }))
    })
}

fn build_wander_task_prompt(
    items_text: &str,
    material_bundle: &str,
    materials_guide: &str,
    multi_choice: bool,
) -> String {
    let output_requirement = if multi_choice {
        [
            "输出合同：仅输出 JSON，不要 Markdown 或解释。",
            "模式：multi_choice。",
            "顶层字段：thinking_process, options。",
            "options 长度必须为 3。",
            "每个 option 必须包含 content_direction, topic, direction_frame。",
            "topic 必须包含 title 和 connections；connections 只能包含 1-3。",
            "direction_frame 必须包含 target_reader, core_tension, angle, material_entry。",
        ]
        .join("\n")
    } else {
        [
            "输出合同：仅输出 JSON，不要 Markdown 或解释。",
            "模式：single_choice。",
            "顶层字段：content_direction, thinking_process, topic, direction_frame。",
            "topic 必须包含 title 和 connections；connections 只能包含 1-3。",
            "direction_frame 必须包含 target_reader, core_tension, angle, material_entry。",
        ]
        .join("\n")
    };

    vec![
        format!("任务：使用已激活的 `{WANDER_SYNTHESIS_SKILL}` 和 `{XHS_TITLE_SKILL}` skills，基于本轮随机素材生成漫步选题。"),
        "边界：只使用本轮素材、宿主预读素材包和必要补读内容；不要引入长期记忆、用户档案、账号定位或其他知识库内容。".to_string(),
        "选题方法：先以 likes 最高的素材作为母版，拆它的标题、结构、情绪和表达公式；另外两条素材只用于寻找小细节、小场景、小反差，不要把三条素材硬串成一个大主题。越细、越小、越具体的选题越好。".to_string(),
        format!("标题：topic.title 必须先按 `{XHS_TITLE_SKILL}` 的小红书标题公式逻辑内部筛选，控制在 20 字以内；最终 JSON 只输出最终标题，不输出公式编号、候选标题或推荐理由。"),
        "工具：预读素材包足够时不要调用工具；确实缺信息时，只补读下面列出的素材路径。".to_string(),
        String::new(),
        output_requirement,
        String::new(),
        "随机素材：".to_string(),
        items_text.to_string(),
        String::new(),
        "宿主预读素材包：".to_string(),
        material_bundle.to_string(),
        String::new(),
        "可补读素材路径：".to_string(),
        materials_guide.to_string(),
    ]
    .join("\n")
}

fn normalize_wander_bundle_text(text: &str, max_chars: usize) -> String {
    truncate_chars(
        &text
            .replace("\r\n", "\n")
            .replace('\r', "\n")
            .split('\n')
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .collect::<Vec<_>>()
            .join("\n"),
        max_chars,
    )
}

fn read_wander_text_excerpt(path: &Path, max_chars: usize) -> Option<String> {
    if !path.is_file() {
        return None;
    }
    fs::read_to_string(path)
        .ok()
        .map(|content| normalize_wander_bundle_text(&content, max_chars))
        .filter(|content| !content.trim().is_empty())
}

fn summarize_wander_meta_file(path: &Path, max_chars: usize) -> Option<String> {
    let content = fs::read_to_string(path).ok()?;
    let parsed = serde_json::from_str::<Value>(&content).ok()?;
    let mut lines = Vec::new();
    for key in [
        "title",
        "author",
        "content",
        "description",
        "summary",
        "excerpt",
        "transcript",
    ] {
        let value = parsed
            .get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|item| !item.is_empty());
        if let Some(value) = value {
            lines.push(format!(
                "{key}: {}",
                normalize_wander_bundle_text(value, 260)
            ));
        }
    }
    if let Some(stats) = parsed.get("stats").filter(|value| !value.is_null()) {
        lines.push(format!(
            "stats: {}",
            truncate_chars(&stats.to_string(), 120).replace('\n', " ")
        ));
    }
    if lines.is_empty() {
        return None;
    }
    Some(truncate_chars(&lines.join("\n"), max_chars))
}

fn has_allowed_wander_text_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .map(|ext| {
            matches!(
                ext.to_ascii_lowercase().as_str(),
                "md" | "markdown" | "txt" | "json" | "html" | "htm" | "srt" | "vtt"
            )
        })
        .unwrap_or(false)
}

fn find_first_matching_wander_file(
    root: &Path,
    exact_names: &[&str],
    tokens: &[&str],
) -> Option<PathBuf> {
    for name in exact_names {
        let candidate = root.join(name);
        if candidate.is_file() && has_allowed_wander_text_extension(&candidate) {
            return Some(candidate);
        }
    }
    let mut matches = fs::read_dir(root)
        .ok()?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.is_file() && has_allowed_wander_text_extension(path))
        .filter(|path| {
            let file_name = path
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            tokens.iter().any(|token| file_name.contains(token))
        })
        .collect::<Vec<_>>();
    matches.sort();
    matches.into_iter().next()
}

fn resolve_wander_item_root(item: &Value) -> Option<PathBuf> {
    let meta = item.get("meta")?.as_object()?;
    meta.get("materialRef")
        .and_then(Value::as_object)
        .and_then(|value| value.get("folderPath"))
        .and_then(Value::as_str)
        .or_else(|| meta.get("folderPath").and_then(Value::as_str))
        .or_else(|| meta.get("filePath").and_then(Value::as_str))
        .map(PathBuf::from)
}

fn wander_visual_blocks(item: &Value) -> Vec<Value> {
    item.get("meta")
        .and_then(Value::as_object)
        .and_then(|meta| meta.get("wanderVisualBlocks"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn format_wander_visual_blocks_for_prompt(item: &Value) -> Option<String> {
    let blocks = wander_visual_blocks(item);
    if blocks.is_empty() {
        return None;
    }
    let lines = blocks
        .iter()
        .take(WANDER_VISUAL_EXCERPT_LIMIT)
        .enumerate()
        .filter_map(|(index, block)| {
            let text = block
                .get("text")
                .and_then(Value::as_str)
                .map(|value| normalize_wander_bundle_text(value, WANDER_VISUAL_EXCERPT_MAX_CHARS))
                .filter(|value| !value.trim().is_empty())?;
            let path = block
                .get("path")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .unwrap_or("image");
            let page = block
                .get("page")
                .and_then(Value::as_i64)
                .map(|value| format!(" page={value}"))
                .unwrap_or_default();
            let block_id = block
                .get("blockId")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .unwrap_or("");
            let block_ref = if block_id.is_empty() {
                String::new()
            } else {
                format!(" blockId={block_id}")
            };
            Some(format!(
                "  [{}] {}{}{}: {}",
                index + 1,
                path,
                page,
                block_ref,
                text
            ))
        })
        .collect::<Vec<_>>();
    if lines.is_empty() {
        None
    } else {
        Some(format!("- 图片文字摘录:\n{}", lines.join("\n")))
    }
}

fn build_wander_material_bundle(items: &[Value]) -> String {
    items
        .iter()
        .enumerate()
        .map(|(index, item)| {
            let title = item
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or("Untitled")
                .trim()
                .to_string();
            let item_type = item
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or("note")
                .trim()
                .to_string();
            let meta = item
                .get("meta")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            let source_type = meta
                .get("sourceType")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_string();
            let summary = item
                .get("content")
                .and_then(Value::as_str)
                .map(|value| normalize_wander_bundle_text(value, 260))
                .unwrap_or_default();
            let mut sections = vec![
                format!("素材 {} | 标题: {}", index + 1, title),
                format!("- 类型: {}", item_type),
                format!("- sourceType: {}", source_type),
            ];
            if !summary.is_empty() {
                sections.push(format!("- 现有摘要: {}", summary));
            }
            if let Some(visual_text) = format_wander_visual_blocks_for_prompt(item) {
                sections.push(visual_text);
            }
            let Some(root) = resolve_wander_item_root(item) else {
                sections.push("- 宿主预读: 未定位到素材根路径。".to_string());
                return sections.join("\n");
            };
            if !root.exists() {
                sections.push(format!("- 宿主预读: 素材路径不存在 ({})", root.display()));
                return sections.join("\n");
            }

            if root.is_file() {
                if let Some(excerpt) = read_wander_text_excerpt(&root, 700) {
                    sections.push(format!(
                        "- 预读正文({}):\n{}",
                        root.file_name()
                            .and_then(|value| value.to_str())
                            .unwrap_or("file"),
                        excerpt
                    ));
                }
                return sections.join("\n");
            }

            let meta_path = root.join("meta.json");
            if let Some(meta_excerpt) = summarize_wander_meta_file(&meta_path, 900) {
                sections.push(format!("- 预读 meta.json:\n{}", meta_excerpt));
            }

            let is_video =
                item_type == "video" || matches!(source_type.as_str(), "youtube" | "xhs-video");
            let primary_text = if source_type == "document" {
                meta.get("relativePath")
                    .and_then(Value::as_str)
                    .map(|value| root.join(normalize_relative_path(value)))
                    .filter(|path| path.is_file())
                    .or_else(|| {
                        find_first_matching_wander_file(
                            &root,
                            &["content.md", "README.md", "index.md"],
                            &["content", "article", "note", "body", "readme"],
                        )
                    })
            } else if is_video {
                let transcript_from_meta = fs::read_to_string(&meta_path)
                    .ok()
                    .and_then(|content| serde_json::from_str::<Value>(&content).ok())
                    .and_then(|value| {
                        value
                            .get("transcriptFile")
                            .and_then(Value::as_str)
                            .map(ToString::to_string)
                    })
                    .map(|relative| root.join(relative));
                transcript_from_meta
                    .filter(|path| path.is_file())
                    .or_else(|| {
                        find_first_matching_wander_file(
                            &root,
                            &["transcript.txt", "subtitle.txt", "content.md"],
                            &[
                                "transcript",
                                "subtitle",
                                "caption",
                                "content",
                                "description",
                            ],
                        )
                    })
            } else {
                find_first_matching_wander_file(
                    &root,
                    &["content.md", "content.txt", "note.md"],
                    &["content", "article", "body", "note", "description"],
                )
            };

            if let Some(primary_text) = primary_text {
                if let Some(excerpt) = read_wander_text_excerpt(&primary_text, 1200) {
                    sections.push(format!(
                        "- 预读正文({}):\n{}",
                        primary_text
                            .file_name()
                            .and_then(|value| value.to_str())
                            .unwrap_or("file"),
                        excerpt
                    ));
                }
            }

            sections.join("\n")
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

fn build_wander_materials_guide(items: &[Value]) -> String {
    items
        .iter()
        .enumerate()
        .map(|(index, item)| {
            let title = item
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or("Untitled");
            let meta = item
                .get("meta")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            let source_type = meta.get("sourceType").and_then(Value::as_str).unwrap_or("");
            let material_ref = meta.get("materialRef").and_then(Value::as_object);
            if source_type == "document" {
                let root_path = material_ref
                    .and_then(|value| value.get("folderPath"))
                    .and_then(Value::as_str)
                    .or_else(|| meta.get("filePath").and_then(Value::as_str))
                    .unwrap_or("")
                    .trim()
                    .to_string();
                return format!(
                    "素材 {} | 标题: {}\n- 仅在 bundle 不足时再补读\n- workspace 路径: {}",
                    index + 1,
                    title,
                    root_path,
                );
            }

            let workspace_path = material_ref
                .and_then(|value| value.get("workspacePath"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToString::to_string);
            let folder_path = material_ref
                .and_then(|value| value.get("folderPath"))
                .and_then(Value::as_str)
                .or_else(|| meta.get("folderPath").and_then(Value::as_str))
                .unwrap_or("")
                .trim()
                .to_string();
            let preferred_path = workspace_path
                .clone()
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| folder_path.clone());
            format!(
                "素材 {} | 标题: {}\n- 仅在 bundle 不足时再补读\n- workspace 路径: {}",
                index + 1,
                title,
                preferred_path,
            )
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

fn is_generic_wander_title(title: &str) -> bool {
    let generic_title_markers = ["延展出的内容选题", "未命名选题"];
    let normalized = title.trim();
    normalized.is_empty()
        || generic_title_markers
            .iter()
            .any(|marker| normalized.contains(marker))
}

fn is_generic_wander_direction(direction: &str) -> bool {
    let generic_direction_markers = [
        "围绕这组素材提炼",
        "围绕素材提炼一个可执行的内容方向",
        "围绕素材提炼一个更聚焦",
    ];
    let normalized = direction.trim();
    normalized.is_empty()
        || generic_direction_markers
            .iter()
            .any(|marker| normalized.contains(marker))
}

fn wander_validation_issue(path: &str, code: &str, message: impl Into<String>) -> Value {
    json!({
        "path": path,
        "code": code,
        "message": message.into(),
    })
}

fn collect_wander_direction_frame_issues(frame: Option<&Value>, path_prefix: &str) -> Vec<Value> {
    let read_field = |snake: &str, camel: &str| {
        frame
            .and_then(|value| value.get(snake).or_else(|| value.get(camel)))
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string()
    };
    let checks = [
        (
            "target_reader",
            "targetReader",
            "missing_target_reader",
            "目标读者",
        ),
        (
            "core_tension",
            "coreTension",
            "missing_core_tension",
            "核心矛盾",
        ),
        ("angle", "angle", "missing_angle", "叙事角度"),
        (
            "material_entry",
            "materialEntry",
            "missing_material_entry",
            "素材切入点",
        ),
    ];
    let mut issues = Vec::new();
    for (snake, camel, code, label) in checks {
        let value = read_field(snake, camel);
        if value.is_empty() {
            issues.push(wander_validation_issue(
                &format!("{path_prefix}.{snake}"),
                code,
                format!("内容方向缺少{label}。"),
            ));
        }
    }
    issues
}

fn collect_wander_option_validation_issues(option: &Value, path_prefix: &str) -> Vec<Value> {
    let title = option
        .get("topic")
        .and_then(|value| value.get("title"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let direction = option
        .get("content_direction")
        .and_then(Value::as_str)
        .unwrap_or("");
    let mut issues = Vec::new();
    if is_generic_wander_title(title) {
        issues.push(wander_validation_issue(
            &format!("{path_prefix}.topic.title"),
            "generic_title",
            "标题缺失，或仍是模板化占位表达。",
        ));
    }
    if is_generic_wander_direction(direction) {
        issues.push(wander_validation_issue(
            &format!("{path_prefix}.content_direction"),
            "generic_direction",
            "内容方向缺失，或仍是模板化占位表达。",
        ));
    }
    issues.extend(collect_wander_direction_frame_issues(
        option.get("direction_frame"),
        &format!("{path_prefix}.direction_frame"),
    ));
    issues
}

fn collect_wander_validation_issues(result: &Value, multi_choice: bool) -> Vec<Value> {
    if multi_choice {
        let options = result
            .get("options")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let mut issues = Vec::new();
        if options.len() != 3 {
            issues.push(wander_validation_issue(
                "options",
                "invalid_option_count",
                "多选模式必须返回 3 条真正不同的候选，不要复制弱结果凑数。",
            ));
        }
        for (index, option) in options.iter().enumerate() {
            issues.extend(collect_wander_option_validation_issues(
                option,
                &format!("options[{index}]"),
            ));
        }
        return issues;
    }

    collect_wander_option_validation_issues(result, "result")
}

fn summarize_wander_validation_issues(issues: &[Value]) -> String {
    let summary = issues
        .iter()
        .filter_map(|issue| issue.get("message").and_then(Value::as_str))
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .take(3)
        .collect::<Vec<_>>()
        .join("；");
    if summary.is_empty() {
        "漫步结果过于空泛，请补齐更具体的标题与内容方向。".to_string()
    } else {
        format!("漫步结果需要继续收紧：{summary}")
    }
}

fn parse_wander_brainstorm_payload(payload: &Value) -> (Vec<Value>, Value) {
    if let Some(items) = payload_field(payload, "items").and_then(Value::as_array) {
        let options = payload_field(payload, "options")
            .cloned()
            .unwrap_or_else(|| json!({}));
        return (items.clone(), options);
    }

    if let Some(array_payload) = payload.as_array() {
        let nested_items = array_payload
            .first()
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let options = array_payload.get(1).cloned().unwrap_or_else(|| json!({}));
        if !nested_items.is_empty() || array_payload.len() > 1 {
            return (nested_items, options);
        }
        return (array_payload.clone(), json!({}));
    }

    (Vec::new(), json!({}))
}

fn parse_wander_session_timestamp(raw: &str) -> i64 {
    raw.trim().parse::<i64>().unwrap_or(0)
}

fn parse_observability_timestamp(raw: &str) -> i64 {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return 0;
    }
    if let Ok(value) = trimmed.parse::<i64>() {
        return value;
    }
    time::OffsetDateTime::parse(trimmed, &time::format_description::well_known::Rfc3339)
        .ok()
        .and_then(|parsed| i64::try_from(parsed.unix_timestamp_nanos() / 1_000_000).ok())
        .unwrap_or(0)
}

fn synthetic_chatroom_session_id(room_id: &str) -> String {
    format!("{CHATROOM_SYNTHETIC_SESSION_PREFIX}{room_id}")
}

fn room_id_from_synthetic_session_id(session_id: &str) -> Option<&str> {
    session_id.strip_prefix(CHATROOM_SYNTHETIC_SESSION_PREFIX)
}

fn take_recent_json_items(mut items: Vec<Value>, limit: Option<usize>) -> Vec<Value> {
    let Some(limit) = limit.filter(|value| *value > 0) else {
        return items;
    };
    if items.len() <= limit {
        return items;
    }
    let split_at = items.len().saturating_sub(limit);
    items.drain(..split_at);
    items
}

fn synthetic_chatroom_session_items(store: &AppStore) -> Vec<Value> {
    let mut items = store
        .chat_rooms
        .iter()
        .filter_map(|room| {
            let session_id = synthetic_chatroom_session_id(&room.id);
            let transcript_count = store
                .chatroom_messages
                .iter()
                .filter(|item| item.room_id == room.id)
                .count();
            let checkpoint_count = store
                .session_checkpoints
                .iter()
                .filter(|item| item.session_id == session_id)
                .count();
            if transcript_count == 0 && checkpoint_count == 0 {
                return None;
            }
            let latest_message_at = store
                .chatroom_messages
                .iter()
                .filter(|item| item.room_id == room.id)
                .max_by_key(|item| parse_observability_timestamp(&item.timestamp))
                .map(|item| item.timestamp.clone());
            let latest_checkpoint_at = store
                .session_checkpoints
                .iter()
                .filter(|item| item.session_id == session_id)
                .max_by_key(|item| item.created_at)
                .map(|item| item.created_at.to_string());
            let updated_at = latest_message_at
                .or(latest_checkpoint_at)
                .unwrap_or_else(|| room.created_at.clone());
            Some(json!({
                "id": session_id,
                "runtimeMode": "team",
                "contextBinding": {
                    "contextType": "team",
                    "contextId": room.id,
                    "isContextBound": true,
                },
                "transcriptCount": transcript_count,
                "checkpointCount": checkpoint_count,
                "chatSession": {
                    "id": synthetic_chatroom_session_id(&room.id),
                    "title": if room.name.trim().is_empty() { "Creative Chat" } else { room.name.as_str() },
                    "updatedAt": updated_at,
                    "createdAt": room.created_at,
                }
            }))
        })
        .collect::<Vec<_>>();
    items.sort_by(|a, b| {
        let left = a
            .get("chatSession")
            .and_then(|item| item.get("updatedAt"))
            .and_then(Value::as_str)
            .map(parse_observability_timestamp)
            .unwrap_or(0);
        let right = b
            .get("chatSession")
            .and_then(|item| item.get("updatedAt"))
            .and_then(Value::as_str)
            .map(parse_observability_timestamp)
            .unwrap_or(0);
        right.cmp(&left)
    });
    items
}

fn synthetic_chatroom_transcript_value(
    store: &AppStore,
    room_id: &str,
    limit: Option<usize>,
) -> Value {
    let mut items = store
        .chatroom_messages
        .iter()
        .filter(|item| item.room_id == room_id)
        .cloned()
        .collect::<Vec<_>>();
    items.sort_by(|left, right| {
        parse_observability_timestamp(&left.timestamp)
            .cmp(&parse_observability_timestamp(&right.timestamp))
            .then_with(|| left.id.cmp(&right.id))
    });
    let transcript = items
        .into_iter()
        .enumerate()
        .map(|(index, item)| {
            let created_at = parse_observability_timestamp(&item.timestamp);
            json!({
                "id": created_at.saturating_mul(1000).saturating_add(index as i64),
                "sessionId": synthetic_chatroom_session_id(room_id),
                "recordType": "message",
                "role": item.role,
                "content": item.content,
                "payload": {
                    "roomId": item.room_id,
                    "advisorId": item.advisor_id,
                    "advisorName": item.advisor_name,
                    "advisorAvatar": item.advisor_avatar,
                    "phase": item.phase,
                    "isStreaming": item.is_streaming,
                    "timestamp": item.timestamp,
                },
                "createdAt": created_at,
            })
        })
        .collect::<Vec<_>>();
    json!(take_recent_json_items(transcript, limit))
}

fn parse_legacy_wander_items_from_context_text(context_text: &str) -> Vec<Value> {
    let normalized = context_text.replace("\r\n", "\n").replace('\r', "\n");
    let mut blocks = Vec::new();
    for (index, chunk) in normalized.split("\n\nItem ").enumerate() {
        let trimmed = chunk.trim();
        if trimmed.is_empty() {
            continue;
        }
        if index == 0 {
            blocks.push(trimmed.to_string());
        } else {
            blocks.push(format!("Item {trimmed}"));
        }
    }

    blocks
        .into_iter()
        .enumerate()
        .filter_map(|(index, block)| {
            let mut title = String::new();
            let mut item_type = String::from("note");
            let mut content = String::new();
            for line in block.lines() {
                if let Some(rest) = line.strip_prefix("Title: ") {
                    title = rest.trim().to_string();
                    continue;
                }
                if let Some(rest) = line.strip_prefix("Type: ") {
                    item_type = rest.trim().to_string();
                    continue;
                }
                if let Some(rest) = line.strip_prefix("Content Summary: ") {
                    content = rest.trim().to_string();
                    continue;
                }
                if !content.is_empty() {
                    content.push('\n');
                    content.push_str(line);
                }
            }
            if title.trim().is_empty() {
                return None;
            }
            let normalized_content = content.trim().trim_end_matches("...").trim().to_string();
            Some(json!({
                "id": format!("legacy-wander-item-{}-{}", index + 1, slug_from_relative_path(&title)),
                "type": if item_type.trim() == "video" { "video" } else { "note" },
                "title": title,
                "content": normalized_content,
                "meta": {
                    "sourceType": "legacy-wander-context"
                }
            }))
        })
        .collect()
}

fn rebuild_wander_history_from_sessions(store: &AppStore) -> Vec<WanderHistoryRecord> {
    let mut sessions = store
        .chat_sessions
        .iter()
        .filter(|session| {
            let metadata = session.metadata.as_ref();
            let context_type = metadata
                .and_then(|value| value.get("contextType"))
                .and_then(Value::as_str)
                .unwrap_or("");
            context_type == "wander"
                || session.id.starts_with("session_wander_")
                || session.title == "Wander Deep Think"
        })
        .cloned()
        .collect::<Vec<_>>();

    sessions.sort_by(|left, right| {
        parse_wander_session_timestamp(&right.updated_at)
            .cmp(&parse_wander_session_timestamp(&left.updated_at))
    });

    let mut rebuilt = Vec::new();
    for session in sessions {
        let mut assistant_messages = store
            .chat_messages
            .iter()
            .filter(|message| {
                message.session_id == session.id && message.role.eq_ignore_ascii_case("assistant")
            })
            .cloned()
            .collect::<Vec<_>>();
        assistant_messages.sort_by(|left, right| {
            parse_wander_session_timestamp(&right.created_at)
                .cmp(&parse_wander_session_timestamp(&left.created_at))
        });
        let Some(latest_assistant) = assistant_messages.into_iter().next() else {
            continue;
        };

        let Some(parsed_payload) = parse_wander_json_payload(&latest_assistant.content) else {
            continue;
        };
        let multi_choice = parsed_payload
            .get("options")
            .and_then(Value::as_array)
            .map(|items| !items.is_empty())
            .or_else(|| {
                parsed_payload
                    .get("choices")
                    .and_then(Value::as_array)
                    .map(|items| !items.is_empty())
            })
            .unwrap_or(false);
        let result_value = normalize_wander_result(parsed_payload, multi_choice);
        let items = session
            .metadata
            .as_ref()
            .and_then(|value| value.get("contextContent"))
            .and_then(Value::as_str)
            .map(parse_legacy_wander_items_from_context_text)
            .unwrap_or_default();
        let created_at = parse_wander_session_timestamp(&session.updated_at)
            .max(parse_wander_session_timestamp(&latest_assistant.created_at));
        rebuilt.push(WanderHistoryRecord {
            id: session.id.clone(),
            items: serde_json::to_string(&items).unwrap_or_else(|_| "[]".to_string()),
            result: serde_json::to_string(&result_value).unwrap_or_else(|_| "{}".to_string()),
            created_at,
        });
    }

    rebuilt
}

pub fn handle_chat_sessions_wander_channel(
    app: &AppHandle,
    state: &State<'_, AppState>,
    channel: &str,
    payload: &Value,
) -> Option<Result<Value, String>> {
    if !matches!(
        channel,
        "chat:getOrCreateFileSession"
            | "chat:getOrCreateContextSession"
            | "chat:list-context-sessions"
            | "chat:create-context-session"
            | "chat:create-diagnostics-session"
            | "chat:get-sessions"
            | "sessions:list"
            | "sessions:get"
            | "sessions:resume"
            | "sessions:fork"
            | "sessions:get-transcript"
            | "sessions:get-tool-results"
            | "chat:get-messages"
            | "chat:create-session"
            | "chat:rename-session"
            | "chat:delete-session"
            | "chat:clear-messages"
            | "chat:compact-context"
            | "chat:get-context-usage"
            | "chat:update-session-metadata"
            | "chat:bind-editor-session"
            | "chat:pick-attachment"
            | "chat:create-path-attachment"
            | "chat:create-inline-attachment"
            | "chat:create-video-thumbnail"
            | "chat:discard-attachments"
            | "chat:transcribe-audio"
            | "wander:list-history"
            | "wander:delete-history"
            | "wander:get-random"
            | "wander:get-guided-items"
            | "wander:brainstorm"
    ) {
        return None;
    }

    Some((|| -> Result<Value, String> {
        match channel {
            "chat:getOrCreateFileSession" => {
                let file_path = payload_string(&payload, "filePath").unwrap_or_default();
                let session_key = format!("file-session:{}", slug_from_relative_path(&file_path));
                let title = title_from_relative_path(&file_path);
                let session = with_store_mut(state, |store| {
                    let (session, _) = ensure_chat_session(
                        &mut store.chat_sessions,
                        Some(session_key),
                        Some(title),
                    );
                    Ok(session.clone())
                })?;
                Ok(json!(session))
            }
            "chat:getOrCreateContextSession" => {
                let context_id = payload_string(&payload, "contextId")
                    .unwrap_or_else(|| make_id("context").to_string());
                let context_type = payload_string(&payload, "contextType")
                    .unwrap_or_else(|| "context".to_string());
                let title =
                    payload_string(&payload, "title").unwrap_or_else(|| "New Chat".to_string());
                let initial_context = payload_string(&payload, "initialContext");
                let working_directory = payload_string(&payload, "workingDirectory");
                let mut metadata = payload_field(&payload, "metadata")
                    .and_then(|value| value.as_object().cloned())
                    .unwrap_or_default();
                if let Some(wd) = working_directory {
                    metadata.insert("workingDirectory".to_string(), Value::String(wd));
                }
                let metadata_value = if metadata.is_empty() {
                    None
                } else {
                    Some(Value::Object(metadata))
                };
                let session = with_store_mut(state, |store| {
                    let session = ensure_context_session(
                        store,
                        &context_type,
                        &context_id,
                        title,
                        initial_context.as_deref(),
                    );
                    Ok(
                        merge_session_metadata_fields(store, &session.id, metadata_value.as_ref())
                            .unwrap_or(session),
                    )
                })?;
                Ok(json!(session))
            }
            "chat:list-context-sessions" => {
                let context_id = payload_string(&payload, "contextId").unwrap_or_default();
                let context_type = payload_string(&payload, "contextType").unwrap_or_default();
                let items = with_store(state, |store| {
                    Ok(list_context_sessions(&store, &context_type, &context_id))
                })?;
                let transcript_meta_by_session_id: HashMap<String, SessionTranscriptFileMeta> =
                    items
                        .iter()
                        .filter_map(|session| {
                            transcript_session_meta_by_id(state, &session.id)
                                .ok()
                                .flatten()
                                .map(|meta| (session.id.clone(), meta))
                        })
                        .collect();
                with_store(state, |store| {
                    Ok(json!(items
                        .iter()
                        .map(|session| {
                            let transcript_meta = transcript_meta_by_session_id.get(&session.id);
                            session_list_item_value(&store, session, transcript_meta)
                        })
                        .collect::<Vec<_>>()))
                })
            }
            "chat:create-context-session" => {
                let context_id = payload_string(&payload, "contextId")
                    .unwrap_or_else(|| make_id("context").to_string());
                let context_type = payload_string(&payload, "contextType")
                    .unwrap_or_else(|| "context".to_string());
                let title =
                    payload_string(&payload, "title").unwrap_or_else(|| "New Chat".to_string());
                let initial_context = payload_string(&payload, "initialContext");
                let working_directory = payload_string(&payload, "workingDirectory");
                let mut metadata = payload_field(&payload, "metadata")
                    .and_then(|value| value.as_object().cloned())
                    .unwrap_or_default();
                if context_type == "advisor-discussion" {
                    metadata.insert("advisorId".to_string(), Value::String(context_id.clone()));
                    let skill_ref = crate::persistence::with_store(state, |store| {
                        Ok(crate::member_skill::advisor_member_skill_ref(
                            &store,
                            &context_id,
                        ))
                    })
                    .ok()
                    .flatten();
                    if let Some(skill_ref) = skill_ref {
                        attach_member_skill_metadata(&mut metadata, &skill_ref);
                    } else {
                        detach_member_skill_metadata(&mut metadata);
                    }
                }
                if let Some(wd) = working_directory {
                    metadata.insert("workingDirectory".to_string(), Value::String(wd));
                }
                let metadata_value = if metadata.is_empty() {
                    None
                } else {
                    Some(Value::Object(metadata))
                };
                let session = with_store_mut(state, |store| {
                    let session = create_context_session(
                        store,
                        &context_type,
                        &context_id,
                        title,
                        initial_context.as_deref(),
                    );
                    Ok(
                        merge_session_metadata_fields(store, &session.id, metadata_value.as_ref())
                            .unwrap_or(session),
                    )
                })?;
                Ok(json!(session))
            }
            "chat:create-diagnostics-session" => {
                let (default_context_type, default_context_id, default_title) =
                    diagnostics_session_defaults();
                let context_type =
                    payload_string(&payload, "contextType").unwrap_or(default_context_type);
                let context_id =
                    payload_string(&payload, "contextId").unwrap_or(default_context_id);
                let title = payload_string(&payload, "title").unwrap_or(default_title);
                let session = with_store_mut(state, |store| {
                    Ok(ensure_context_session(
                        store,
                        &context_type,
                        &context_id,
                        title,
                        None,
                    ))
                })?;
                Ok(json!(session))
            }
            "chat:get-sessions" => with_store(state, |store| Ok(json!(list_sessions(&store)))),
            "sessions:list" => {
                let started_at = now_ms();
                let request_id = format!("sessions:list:{}", started_at);
                let transcript_index = list_transcript_sessions(state).unwrap_or_default();
                let transcript_meta_by_session_id: HashMap<String, SessionTranscriptFileMeta> =
                    transcript_index
                        .iter()
                        .cloned()
                        .map(|item| (item.session_id.clone(), item))
                        .collect();
                let transcript_items: Vec<Value> = transcript_index
                    .iter()
                    .map(crate::runtime::transcript_session_meta_value)
                    .collect();
                let items = with_store(state, |store| {
                    let mut items: Vec<Value> = if transcript_items.is_empty() {
                        list_sessions(&store)
                            .into_iter()
                            .map(|session| {
                                let transcript_meta =
                                    transcript_meta_by_session_id.get(&session.id);
                                session_list_item_value(&store, &session, transcript_meta)
                            })
                            .collect()
                    } else {
                        let mut merged = transcript_items;
                        let known_ids = merged
                            .iter()
                            .filter_map(|item| item.get("id").and_then(Value::as_str))
                            .map(ToString::to_string)
                            .collect::<HashSet<_>>();
                        let mut store_only = store
                            .chat_sessions
                            .iter()
                            .filter(|session| !known_ids.contains(&session.id))
                            .map(|session| {
                                let transcript_meta =
                                    transcript_meta_by_session_id.get(&session.id);
                                session_list_item_value(&store, session, transcript_meta)
                            })
                            .collect::<Vec<_>>();
                        merged.append(&mut store_only);
                        merged.sort_by(|a, b| {
                            let left = a
                                .get("chatSession")
                                .and_then(|item| item.get("updatedAt"))
                                .and_then(Value::as_str)
                                .unwrap_or("");
                            let right = b
                                .get("chatSession")
                                .and_then(|item| item.get("updatedAt"))
                                .and_then(Value::as_str)
                                .unwrap_or("");
                            right.cmp(left)
                        });
                        merged
                    };
                    let known_ids = items
                        .iter()
                        .filter_map(|item| item.get("id").and_then(Value::as_str))
                        .map(ToString::to_string)
                        .collect::<HashSet<_>>();
                    let mut synthetic_items = synthetic_chatroom_session_items(&store)
                        .into_iter()
                        .filter(|item| {
                            item.get("id")
                                .and_then(Value::as_str)
                                .map(|id| !known_ids.contains(id))
                                .unwrap_or(false)
                        })
                        .collect::<Vec<_>>();
                    items.append(&mut synthetic_items);
                    items.sort_by(|a, b| {
                        let left = a
                            .get("chatSession")
                            .and_then(|item| item.get("updatedAt"))
                            .and_then(Value::as_str)
                            .map(parse_observability_timestamp)
                            .unwrap_or(0);
                        let right = b
                            .get("chatSession")
                            .and_then(|item| item.get("updatedAt"))
                            .and_then(Value::as_str)
                            .map(parse_observability_timestamp)
                            .unwrap_or(0);
                        right.cmp(&left)
                    });
                    Ok(items)
                })?;
                log_timing_event(
                    state,
                    "settings",
                    &request_id,
                    "sessions:list",
                    started_at,
                    Some(format!("sessions={}", items.len())),
                );
                Ok(json!(items))
            }
            "sessions:get" => {
                let requested_session_id = payload_string(&payload, "sessionId");
                let session_id = with_store(state, |store| {
                    Ok(resolve_resume_target_session_id(
                        &store,
                        requested_session_id.as_deref(),
                    ))
                })?;
                let Some(session_id) = session_id else {
                    return Ok(Value::Null);
                };
                hydrate_session_file_if_needed(state, &session_id)?;
                let transcript_meta = transcript_session_meta_by_id(state, &session_id)
                    .ok()
                    .flatten();
                with_store(state, |store| {
                    Ok(session_detail_value(
                        &store,
                        &session_id,
                        transcript_meta.as_ref(),
                    ))
                })
            }
            "sessions:resume" => {
                let requested_session_id = payload_string(&payload, "sessionId");
                let store_snapshot = with_store(state, |store| Ok(store.clone()))?;
                let Some(session_id) = resolve_resume_target_session_id(
                    &store_snapshot,
                    requested_session_id.as_deref(),
                ) else {
                    return Ok(Value::Null);
                };
                hydrate_session_file_if_needed(state, &session_id)?;
                let store_snapshot = with_store(state, |store| Ok(store.clone()))?;
                let transcript_meta = transcript_session_meta_by_id(state, &session_id)
                    .ok()
                    .flatten();
                let resume_messages = transcript_resume_messages(
                    state,
                    &store_snapshot,
                    &session_id,
                    crate::runtime::SESSION_CONTEXT_TAIL_MESSAGES,
                )
                .ok();
                let value = session_resume_value(
                    &store_snapshot,
                    &session_id,
                    transcript_meta.as_ref(),
                    resume_messages.clone(),
                );
                if !value.is_null() {
                    return Ok(value);
                }
                Ok(json!({
                    "chatSession": transcript_meta.as_ref().map(|meta| json!({
                        "id": meta.session_id,
                        "title": meta.title,
                        "updatedAt": meta.updated_at,
                        "createdAt": meta.created_at,
                    })).unwrap_or(Value::Null),
                    "summary": transcript_meta.as_ref().map(|meta| meta.summary.clone()).unwrap_or_default(),
                    "messageCount": transcript_meta.as_ref().map(|meta| meta.message_count).unwrap_or(0),
                    "context": Value::Null,
                    "resumeMessages": resume_messages.unwrap_or_default(),
                    "lastCheckpoint": Value::Null,
                }))
            }
            "sessions:fork" => {
                let session_id = payload_string(&payload, "sessionId").unwrap_or_default();
                let forked = with_store_mut(state, |store| {
                    let Some(forked) = fork_session(store, &session_id) else {
                        return Ok(json!({ "success": false, "error": "会话不存在" }));
                    };
                    Ok(json!({
                        "success": true,
                        "session": {
                            "id": forked.session.id,
                            "transcriptCount": forked.transcript_count,
                            "checkpointCount": forked.checkpoint_count,
                        }
                    }))
                })?;
                if let Some(new_id) = forked
                    .get("session")
                    .and_then(|item| item.get("id"))
                    .and_then(Value::as_str)
                {
                    let _ = crate::runtime::duplicate_session_bundle(state, &session_id, new_id);
                }
                Ok(forked)
            }
            "sessions:get-transcript" => {
                let requested_session_id = payload_string(&payload, "sessionId");
                let limit = payload
                    .get("limit")
                    .and_then(Value::as_u64)
                    .map(|value| value as usize);
                if let Some(room_id) = requested_session_id
                    .as_deref()
                    .and_then(room_id_from_synthetic_session_id)
                {
                    return with_store(state, |store| {
                        return Ok(synthetic_chatroom_transcript_value(&store, room_id, limit));
                    });
                }
                let session_id = with_store(state, |store| {
                    Ok(resolve_resume_target_session_id(
                        &store,
                        requested_session_id.as_deref(),
                    ))
                })?;
                let Some(session_id) = session_id else {
                    return Ok(json!([]));
                };
                hydrate_session_file_if_needed(state, &session_id)?;
                with_store(state, |store| {
                    Ok(trace_value_for_session(&store, &session_id, false, limit))
                })
            }
            "sessions:get-tool-results" => {
                let requested_session_id = payload_string(&payload, "sessionId");
                let limit = payload
                    .get("limit")
                    .and_then(Value::as_u64)
                    .map(|value| value as usize);
                let session_id = with_store(state, |store| {
                    Ok(resolve_resume_target_session_id(
                        &store,
                        requested_session_id.as_deref(),
                    ))
                })?;
                let Some(session_id) = session_id else {
                    return Ok(json!([]));
                };
                hydrate_session_file_if_needed(state, &session_id)?;
                with_store(state, |store| {
                    Ok(tool_results_value_for_session(
                        &store,
                        &session_id,
                        false,
                        None,
                        limit,
                    ))
                })
            }
            "chat:get-messages" => {
                let requested_session_id = payload_value_as_string(&payload);
                let session_id = with_store(state, |store| {
                    Ok(resolve_resume_target_session_id(
                        &store,
                        requested_session_id.as_deref(),
                    ))
                })?;
                let Some(session_id) = session_id else {
                    return Ok(json!([]));
                };
                let loaded_messages = with_store(state, |store| {
                    Ok(crate::persistence::is_session_file_loaded(
                        &store,
                        &session_id,
                    ))
                })?;
                if !loaded_messages {
                    let messages = crate::persistence::load_session_messages_from_file(
                        &state.store_path,
                        &session_id,
                    )
                    .unwrap_or_else(|error| {
                        eprintln!(
                            "[{}] failed to stream session messages {}: {error}",
                            app_brand_display_name(),
                            session_id,
                        );
                        Vec::new()
                    });
                    return Ok(json!(messages));
                }
                with_store(state, |store| {
                    let mut seen = HashSet::new();
                    let mut messages: Vec<ChatMessageRecord> = store
                        .chat_messages
                        .iter()
                        .filter(|item| {
                            item.session_id == session_id
                                && (item.role == "user" || item.role == "assistant")
                                && seen.insert(item.id.clone())
                        })
                        .cloned()
                        .collect();
                    messages.sort_by(|a, b| a.created_at.cmp(&b.created_at));
                    Ok(json!(messages))
                })
            }
            "chat:create-session" => {
                let title =
                    payload_value_as_string(&payload).unwrap_or_else(|| "New Chat".to_string());
                let session =
                    with_store_mut(state, |store| Ok(create_session(store, title, None)))?;
                Ok(json!(session))
            }
            "chat:delete-session" => {
                let session_id = payload_value_as_string(&payload).unwrap_or_default();
                with_store_mut(state, |store| {
                    let _ = delete_session(store, &session_id);
                    Ok(json!({ "success": true }))
                })?;
                let _ = crate::runtime::remove_session_bundle(state, &session_id);
                let _ = crate::persistence::delete_session_file(&state.store_path, &session_id);
                Ok(json!({ "success": true }))
            }
            "chat:archive-session" => {
                let session_id = payload_value_as_string(&payload).unwrap_or_default();
                with_store_mut(state, |store| {
                    if let Some(session) =
                        store.chat_sessions.iter_mut().find(|s| s.id == session_id)
                    {
                        session.archived = true;
                        session.archived_at = Some(
                            std::time::SystemTime::now()
                                .duration_since(std::time::UNIX_EPOCH)
                                .map(|d| d.as_millis() as i64)
                                .unwrap_or(0),
                        );
                    }
                    remove_session_artifacts(store, &session_id);
                    Ok(json!({ "success": true }))
                })?;
                let _ = crate::persistence::archive_session(&state.store_path, &session_id);
                let _ = crate::runtime::remove_session_bundle(state, &session_id);
                if let Ok(mut guard) = state.chat_runtime_states.lock() {
                    guard.remove(&session_id);
                }
                Ok(json!({ "success": true }))
            }
            "chat:unarchive-session" => {
                let session_id = payload_value_as_string(&payload).unwrap_or_default();
                let loaded =
                    crate::persistence::unarchive_session(&state.store_path, &session_id).is_ok();
                if loaded {
                    // Reload session data into memory
                    if let Ok(entries) =
                        crate::persistence::load_session_file(&state.store_path, &session_id)
                    {
                        with_store_mut(state, |store| {
                            crate::persistence::apply_session_file_entries_to_store(store, entries);
                            Ok(json!({ "success": true }))
                        })?;
                    }
                }
                Ok(json!({ "success": loaded }))
            }
            "chat:list-archived-sessions" => {
                let index =
                    crate::persistence::load_session_index(&state.store_path).unwrap_or_default();
                let archived: Vec<Value> = index
                    .into_iter()
                    .filter(|e| e.archived)
                    .map(|e| {
                        json!({
                            "id": e.id,
                            "title": e.title,
                            "createdAt": e.created_at,
                            "updatedAt": e.updated_at,
                            "archivedAt": e.archived_at,
                            "messageCount": e.message_count,
                        })
                    })
                    .collect();
                Ok(json!(archived))
            }
            "chat:clear-messages" => {
                let session_id = payload_value_as_string(&payload).unwrap_or_default();
                with_store_mut(state, |store| {
                    store
                        .chat_messages
                        .retain(|item| item.session_id != session_id);
                    store
                        .session_transcript_records
                        .retain(|item| item.session_id != session_id);
                    store
                        .session_checkpoints
                        .retain(|item| item.session_id != session_id);
                    store
                        .session_tool_results
                        .retain(|item| item.session_id != session_id);
                    store
                        .session_context_records
                        .retain(|item| item.session_id != session_id);
                    Ok(json!({ "success": true }))
                })?;
                if let Ok(mut guard) = state.chat_runtime_states.lock() {
                    guard.remove(&session_id);
                }
                let _ = crate::runtime::remove_session_bundle(state, &session_id);
                Ok(json!({ "success": true }))
            }
            "chat:compact-context" => {
                let session_id = payload_value_as_string(&payload).unwrap_or_default();
                let result = with_store_mut(state, |store| {
                    let total_messages =
                        crate::runtime::session_message_count_for_session(store, &session_id);
                    let snapshot =
                        update_session_context_record(store, &session_id, "manual", true);
                    Ok(match snapshot {
                        Some(record) => json!({
                            "success": true,
                            "compacted": true,
                            "message": format!(
                                "已归档 {} 条历史消息，保留最近 {} 条用于继续对话",
                                record.compacted_message_count,
                                record.tail_message_count
                            ),
                            "context": crate::runtime::session_context_value_for_session(store, &session_id),
                            "usage": crate::runtime::session_context_usage_value(store, &session_id),
                            "totalMessages": total_messages,
                        }),
                        None => json!({
                            "success": true,
                            "compacted": false,
                            "message": if total_messages <= crate::runtime::SESSION_CONTEXT_TAIL_MESSAGES as i64 {
                                format!(
                                    "当前仅有 {} 条消息，至少需要超过 {} 条消息才有可归档内容",
                                    total_messages,
                                    crate::runtime::SESSION_CONTEXT_TAIL_MESSAGES
                                )
                            } else {
                                let usage = crate::runtime::session_context_usage_value(store, &session_id);
                                let threshold = usage
                                    .get("compactThreshold")
                                    .and_then(Value::as_i64)
                                    .unwrap_or(crate::runtime::DEFAULT_SESSION_COMPACT_TARGET_TOKENS);
                                let effective = usage
                                    .get("estimatedEffectiveTokens")
                                    .and_then(Value::as_i64)
                                    .unwrap_or(0);
                                format!(
                                    "当前有效上下文约 {} tokens，尚未超过自动 compact 阈值 {}，且没有新的可归档历史",
                                    effective,
                                    threshold
                                )
                            }
                        }),
                    })
                })?;
                if result
                    .get("compacted")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
                {
                    let summary = result
                        .get("context")
                        .and_then(|value| value.get("summary"))
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    let _ = with_store(state, |store| {
                        append_compact_boundary_entry(state, &store, &session_id, summary)
                    });
                }
                Ok(result)
            }
            "chat:get-context-usage" => {
                let session_id = payload_value_as_string(&payload).unwrap_or_default();
                with_store(state, |store| {
                    Ok(session_context_usage_value(&store, &session_id))
                })
            }
            "chat:update-session-metadata" => {
                let session_id = payload_string(&payload, "sessionId").unwrap_or_default();
                let metadata = payload_field(&payload, "metadata").cloned();
                with_store_mut(state, |store| {
                    let _ = update_metadata(store, &session_id, metadata);
                    Ok(json!({ "success": true }))
                })
            }
            "chat:rename-session" => {
                let session_id = payload_string(&payload, "sessionId").unwrap_or_default();
                let title = payload_string(&payload, "title").unwrap_or_default();
                if session_id.trim().is_empty() {
                    return Err("missing sessionId".to_string());
                }
                if title.trim().is_empty() {
                    return Err("missing title".to_string());
                }
                let session = with_store_mut(state, |store| {
                    rename_session(store, &session_id, title)
                        .ok_or_else(|| "session not found".to_string())
                })?;
                let _ = app.emit(
                    "chat:session-title-updated",
                    json!({
                        "sessionId": session.id,
                        "title": session.title,
                    }),
                );
                Ok(json!({ "success": true, "session": session }))
            }
            "chat:bind-editor-session" => {
                let request =
                    serde_json::from_value::<EditorChatBindingRequest>(payload.clone())
                        .map_err(|error| format!("invalid editor chat binding payload: {error}"))?;
                let session = with_store_mut(state, |store| bind_editor_session(store, request))?;
                Ok(json!(session))
            }
            "chat:pick-attachment" => {
                let files = pick_files_native("选择要发送给 AI 的文件", false, false)?;
                let Some(path) = files.into_iter().next() else {
                    return Ok(json!({ "success": true, "canceled": true }));
                };
                let attachment = create_chat_attachment_for_path(app, state, &path)?;
                Ok(json!({ "success": true, "canceled": false, "attachment": attachment }))
            }
            "chat:create-path-attachment" => {
                let path = payload_string(&payload, "path")
                    .map(PathBuf::from)
                    .ok_or_else(|| "缺少文件路径".to_string())?;
                let attachment = create_chat_attachment_for_path(app, state, &path)?;
                Ok(json!({ "success": true, "attachment": attachment }))
            }
            "chat:create-inline-attachment" => {
                let data_url = payload_string(&payload, "dataUrl")
                    .ok_or_else(|| "缺少 dataUrl".to_string())?;
                let file_name = payload_string(&payload, "fileName")
                    .filter(|value| !value.trim().is_empty())
                    .unwrap_or_else(|| format!("inline-image-{}.png", now_ms()));
                let safe_file_name = sanitize_chat_attachment_name(&file_name);
                let temp_dir = store_root(state)?
                    .join("tmp")
                    .join("chat-inline-attachments");
                fs::create_dir_all(&temp_dir).map_err(|error| error.to_string())?;
                let output_path = temp_dir.join(format!("{}-{}", now_ms(), safe_file_name));
                write_base64_payload_to_file(&data_url, &output_path)?;
                let metadata = fs::metadata(&output_path).map_err(|error| error.to_string())?;
                let (_, attachment_kind, _) = guess_mime_and_kind(&output_path);
                let imported_media_asset = if attachment_kind == "image" {
                    crate::knowledge::import_chat_attachment_image(Some(app), state, &output_path)
                        .ok()
                } else {
                    None
                };
                let staged = if imported_media_asset.is_some() {
                    None
                } else if attachment_can_use_original_media_path(&attachment_kind) {
                    None
                } else {
                    stage_chat_attachment_for_workspace(state, &output_path, metadata.len())
                };
                if imported_media_asset.is_none()
                    && staged.is_none()
                    && !attachment_can_use_original_media_path(&attachment_kind)
                {
                    if metadata.len() == 0 {
                        return Err("文件为空，无法作为聊天附件发送。".to_string());
                    }
                    if metadata.len() > CHAT_ATTACHMENT_STAGE_MAX_BYTES {
                        return Err(format!(
                            "文件超过 {} MB，当前无法稳定暂存给 AI 工具处理。",
                            CHAT_ATTACHMENT_STAGE_MAX_BYTES / 1024 / 1024
                        ));
                    }
                    return Err(
                        "文件未能进入工作区暂存区，当前无法稳定交给 AI 工具处理。".to_string()
                    );
                }
                let imported_absolute_path = imported_media_asset
                    .as_ref()
                    .and_then(|asset| asset.absolute_path.as_ref())
                    .map(PathBuf::from);
                let effective_path = imported_absolute_path
                    .as_deref()
                    .or_else(|| staged.as_ref().map(|(absolute, _)| absolute.as_path()))
                    .unwrap_or(output_path.as_path());
                let attachment = chat_attachment_value_for_path(
                    app,
                    state,
                    &output_path,
                    effective_path,
                    metadata.len(),
                    staged.as_ref().map(|(_, relative)| relative.clone()),
                    imported_media_asset.as_ref(),
                );
                register_pending_chat_attachment(state, &attachment);
                Ok(json!({ "success": true, "attachment": attachment }))
            }
            "chat:create-video-thumbnail" => {
                let source = payload_string(&payload, "path")
                    .or_else(|| payload_string(&payload, "source"))
                    .ok_or_else(|| "缺少视频路径".to_string())?;
                let source_path =
                    resolve_local_path(&source).unwrap_or_else(|| PathBuf::from(source.trim()));
                eprintln!(
                    "[chat-thumbnail] request source={} resolved={}",
                    source,
                    source_path.display()
                );
                append_debug_log_state(
                    state,
                    format!(
                        "[chat-thumbnail] request source={} resolved={}",
                        source,
                        source_path.display()
                    ),
                );
                let thumbnail_url = ensure_video_thumbnail_for_path(Some(app), state, &source_path)
                    .ok_or_else(|| format!("无法生成视频封面: {}", source_path.display()))?;
                eprintln!(
                    "[chat-thumbnail] success source={} thumbnail={}",
                    source_path.display(),
                    thumbnail_url
                );
                append_debug_log_state(
                    state,
                    format!(
                        "[chat-thumbnail] success source={} thumbnail={}",
                        source_path.display(),
                        thumbnail_url
                    ),
                );
                Ok(json!({
                    "success": true,
                    "thumbnailUrl": thumbnail_url,
                    "thumbnailDataUrl": thumbnail_url,
                }))
            }
            "chat:discard-attachments" => {
                discard_chat_attachments_state(state, payload_field(&payload, "attachments"))?;
                Ok(json!({ "success": true }))
            }
            "chat:transcribe-audio" => {
                let settings_snapshot = with_store(state, |store| Ok(store.settings.clone()))?;
                let Some(audio_base64) = payload_string(&payload, "audioBase64") else {
                    return Ok(json!({ "success": false, "error": "缺少音频内容" }));
                };
                let mime_type = payload_string(&payload, "mimeType")
                    .unwrap_or_else(|| "audio/webm".to_string());
                let file_name = payload_string(&payload, "fileName")
                    .unwrap_or_else(|| format!("chat-audio-{}.webm", now_ms()));
                let Some((endpoint, api_key, model_name)) =
                    resolve_transcription_settings(&settings_snapshot)
                else {
                    return Ok(
                        json!({ "success": false, "error": "未配置音频转写服务，请先在设置中填写 transcription endpoint/model。" }),
                    );
                };
                let temp_dir = store_root(state)?.join("tmp");
                fs::create_dir_all(&temp_dir).map_err(|error| error.to_string())?;
                let audio_path = temp_dir.join(file_name);
                write_base64_payload_to_file(&audio_base64, &audio_path)?;
                let transcription_result = run_curl_transcription(
                    &endpoint,
                    api_key.as_deref(),
                    &model_name,
                    &audio_path,
                    &mime_type,
                )
                .or_else(|error| {
                    let fallback = fs::metadata(&audio_path)
                        .ok()
                        .map(|metadata| {
                            format!(
                                "mime={}, bytes={}, source_error={}",
                                mime_type,
                                metadata.len(),
                                error
                            )
                        })
                        .unwrap_or_else(|| format!("mime={}, source_error={}", mime_type, error));
                    if fallback.is_empty() {
                        Err("语音转写失败".to_string())
                    } else {
                        Err(format!("__transcription_unavailable__::{fallback}"))
                    }
                });
                let _ = fs::remove_file(&audio_path);
                match transcription_result {
                    Ok(text) => {
                        let trimmed = text.trim().to_string();
                        if trimmed.is_empty() {
                            Ok(json!({
                                "success": false,
                                "reason": "empty_transcript",
                                "error": "未识别到可用语音内容",
                            }))
                        } else {
                            Ok(json!({ "success": true, "text": trimmed }))
                        }
                    }
                    Err(error) if error.starts_with("__transcription_unavailable__::") => {
                        let diagnostic = error
                            .trim_start_matches("__transcription_unavailable__::")
                            .trim()
                            .to_string();
                        Ok(json!({
                            "success": false,
                            "reason": "transcription_unavailable",
                            "error": "音频已接收，但当前转写接口不可用",
                            "diagnostic": diagnostic,
                        }))
                    }
                    Err(error) => Ok(json!({
                        "success": false,
                        "reason": "transcription_failed",
                        "error": error,
                    })),
                }
            }
            "wander:list-history" => with_store_mut(state, |store| {
                if store.wander_history.is_empty() {
                    let rebuilt = rebuild_wander_history_from_sessions(store);
                    if !rebuilt.is_empty() {
                        store.wander_history = rebuilt;
                    }
                }
                let mut history = store.wander_history.clone();
                history.sort_by(|a, b| b.created_at.cmp(&a.created_at));
                Ok(json!(history))
            }),
            "wander:delete-history" => {
                let history_id = payload_value_as_string(&payload).unwrap_or_default();
                with_store_mut(state, |store| {
                    store.wander_history.retain(|item| item.id != history_id);
                    Ok(json!({ "success": true }))
                })
            }
            "wander:get-random" => {
                let (excluded_ids, candidates) = with_store(state, |store| {
                    Ok((
                        recent_wander_excluded_ids(&store, 5),
                        collect_wander_candidate_items(&store),
                    ))
                })?;
                let ready_candidates = enrich_wander_items_with_optional_index(state, candidates)?;
                if ready_candidates.len() < WANDER_READY_MIN_ITEMS {
                    Ok(json!([]))
                } else {
                    Ok(json!(pick_random_wander_items(
                        ready_candidates,
                        WANDER_READY_MIN_ITEMS,
                        &excluded_ids,
                    )))
                }
            }
            "wander:get-guided-items" => with_store(state, |store| {
                compose_guided_wander_items_for_state(state, &store, &payload)
            }),
            "wander:brainstorm" => {
                let request_started_at = now_ms();
                let (mut items, options) = parse_wander_brainstorm_payload(&payload);
                let request_id = payload_string(&options, "requestId")
                    .unwrap_or_else(|| make_id("wander-request"));
                log_timing_event(
                    state,
                    "wander",
                    &request_id,
                    "request-received",
                    request_started_at,
                    Some(format!("inputItems={}", items.len())),
                );
                if items.is_empty() {
                    let (excluded_ids, candidates) = with_store(state, |store| {
                        Ok((
                            recent_wander_excluded_ids(&store, 5),
                            collect_wander_candidate_items(&store),
                        ))
                    })?;
                    let ready_candidates =
                        enrich_wander_items_with_optional_index(state, candidates)?;
                    items = pick_random_wander_items(
                        ready_candidates,
                        WANDER_READY_MIN_ITEMS,
                        &excluded_ids,
                    );
                } else {
                    items = enrich_wander_items_with_optional_index(state, items)?;
                }
                if items.len() < WANDER_READY_MIN_ITEMS {
                    return Ok(json!({
                        "error": WANDER_NOT_ENOUGH_ITEMS_MESSAGE,
                        "result": Value::Null,
                        "historyId": Value::Null,
                        "items": []
                    }));
                }
                let settings_started_at = now_ms();
                let warm_wander = ensure_runtime_warm_entry(state, "wander")?;
                log_timing_event(
                    state,
                    "wander",
                    &request_id,
                    "load-settings",
                    settings_started_at,
                    Some(format!("warmedAt={}", warm_wander.warmed_at)),
                );
                let multi_choice = payload_field(&options, "multiChoice")
                    .and_then(|value| value.as_bool())
                    .unwrap_or(false);
                let wander_session_id =
                    format!("session_wander_{}", slug_from_relative_path(&request_id));
                let _ = app.emit(
                    "wander:progress",
                    json!({
                        "requestId": request_id.clone(),
                        "sessionId": wander_session_id.clone(),
                        "phase": "collect",
                        "stepIndex": 1,
                        "totalSteps": 3,
                        "title": "选择随机素材",
                        "status": "completed",
                        "detail": format!("已装载 {} 条随机素材。", items.len()),
                    }),
                );
                let context_started_at = now_ms();
                let _ = app.emit(
                    "wander:progress",
                    json!({
                        "requestId": request_id.clone(),
                        "sessionId": wander_session_id.clone(),
                        "phase": "context",
                        "stepIndex": 2,
                        "totalSteps": 3,
                        "title": "构建上下文",
                        "status": "running",
                        "detail": "正在预读本轮素材...",
                    }),
                );
                log_timing_event(
                    state,
                    "wander",
                    &request_id,
                    "material-context-ready",
                    context_started_at,
                    Some(format!("inputItems={}", items.len())),
                );
                let _ = app.emit(
                    "wander:progress",
                    json!({
                        "requestId": request_id.clone(),
                        "sessionId": wander_session_id.clone(),
                        "phase": "context",
                        "stepIndex": 2,
                        "totalSteps": 3,
                        "title": "构建上下文",
                        "status": "completed",
                        "detail": "本轮素材与宿主预读摘录已准备完成。",
                    }),
                );
                let items_text = build_wander_items_text(&items);
                let material_bundle = build_wander_material_bundle(&items);
                let materials_guide = build_wander_materials_guide(&items);
                let prompt = build_wander_task_prompt(
                    &items_text,
                    &material_bundle,
                    &materials_guide,
                    multi_choice,
                );
                log_timing_event(
                    state,
                    "wander",
                    &request_id,
                    "prompt-ready",
                    context_started_at,
                    Some(format!("promptChars={}", prompt.chars().count())),
                );
                let session_started_at = now_ms();
                with_store_mut(state, |store| {
                    let (session, _) = ensure_chat_session(
                        &mut store.chat_sessions,
                        Some(wander_session_id.clone()),
                        Some("Wander Deep Think".to_string()),
                    );
                    let mut metadata = serde_json::Map::new();
                    metadata.insert(
                        "contextId".to_string(),
                        json!(format!("wander:{}", request_id)),
                    );
                    metadata.insert("contextType".to_string(), json!("wander"));
                    metadata.insert("contextContent".to_string(), json!(items_text));
                    metadata.insert("isContextBound".to_string(), json!(true));
                    metadata.insert("allowedTools".to_string(), json!(["resource"]));
                    let required_skills = vec![
                        WANDER_SYNTHESIS_SKILL.to_string(),
                        XHS_TITLE_SKILL.to_string(),
                    ];
                    metadata.insert("requiredSkill".to_string(), json!(required_skills.clone()));
                    metadata.insert(
                        "wanderMaterialBundleChars".to_string(),
                        json!(material_bundle.chars().count()),
                    );
                    session.metadata = Some(merge_requested_skills_into_metadata(
                        Some(&Value::Object(metadata)),
                        &required_skills,
                        SkillActivationSource::ContextDefault,
                        "wander-brainstorm-default",
                    ));
                    session.updated_at = now_iso();
                    Ok(())
                })?;
                log_timing_event(
                    state,
                    "wander",
                    &request_id,
                    "session-ready",
                    session_started_at,
                    Some(format!("sessionId={}", wander_session_id)),
                );
                let _ = app.emit(
                    "wander:progress",
                    json!({
                        "requestId": request_id.clone(),
                        "sessionId": wander_session_id.clone(),
                        "phase": "generate",
                        "stepIndex": 3,
                        "totalSteps": 3,
                        "title": "生成选题",
                        "status": "running",
                        "detail": "正在启动漫步 Agent，并基于已读取的关键素材生成最终选题。",
                    }),
                );
                let execution_started_at = now_ms();
                let model_result = generate_wander_response(
                    app,
                    state,
                    &wander_session_id,
                    warm_wander
                        .model_config
                        .as_ref()
                        .ok_or_else(|| "wander model config missing".to_string())?,
                    &prompt,
                )
                .map(|response| {
                    append_debug_log_state(
                        state,
                        format!(
                            "[runtime][wander][{}] single-pass-succeeded",
                            wander_session_id
                        ),
                    );
                    response
                })
                .map_err(|error| {
                    append_debug_log_state(
                        state,
                        format!(
                            "[runtime][wander][{}] wander-runtime-failed | {}",
                            wander_session_id, error
                        ),
                    );
                    error
                })?;
                log_timing_event(
                    state,
                    "wander",
                    &request_id,
                    "execution-finished",
                    execution_started_at,
                    Some(format!("responseChars={}", model_result.chars().count())),
                );
                let parse_started_at = now_ms();
                let parsed_payload = parse_wander_json_payload(&model_result)
                    .unwrap_or_else(|| json!({ "content_direction": model_result.clone() }));
                let result_value = normalize_wander_result(parsed_payload, multi_choice);
                log_timing_event(
                    state,
                    "wander",
                    &request_id,
                    "result-parsed",
                    parse_started_at,
                    None,
                );
                let result_text =
                    serde_json::to_string(&result_value).map_err(|error| error.to_string())?;
                let validation_issues =
                    collect_wander_validation_issues(&result_value, multi_choice);
                if !validation_issues.is_empty() {
                    let error_message = summarize_wander_validation_issues(&validation_issues);
                    with_store_mut(state, |store| {
                        if let Some(session) = store
                            .chat_sessions
                            .iter_mut()
                            .find(|item| item.id == wander_session_id)
                        {
                            let mut metadata = session
                                .metadata
                                .clone()
                                .and_then(|value| value.as_object().cloned())
                                .unwrap_or_default();
                            metadata.insert(
                                "wanderLastValidationFailure".to_string(),
                                json!({
                                    "error": error_message,
                                    "validationIssues": validation_issues.clone(),
                                    "result": result_value.clone(),
                                }),
                            );
                            session.metadata = Some(Value::Object(metadata));
                            session.updated_at = now_iso();
                        }
                        append_session_checkpoint(
                            store,
                            &wander_session_id,
                            "wander-validation-failed",
                            "Wander validation failed".to_string(),
                            Some(json!({
                                "validationIssues": validation_issues.clone(),
                                "responsePreview": text_snippet(&result_text, 220),
                            })),
                        );
                        Ok(())
                    })?;
                    let _ = app.emit(
                        "wander:progress",
                        json!({
                            "requestId": request_id.clone(),
                            "sessionId": wander_session_id.clone(),
                            "phase": "complete",
                            "stepIndex": 3,
                            "totalSteps": 3,
                            "title": "校验候选",
                            "status": "error",
                            "detail": error_message.clone(),
                        }),
                    );
                    return Ok(json!({
                        "error": error_message,
                        "result": result_text,
                        "items": items,
                        "validationIssues": validation_issues,
                        "historyId": Value::Null,
                    }));
                }
                let history_id = make_id("wander");
                let history_started_at = now_ms();
                with_store_mut(state, |store| {
                    store.chat_messages.push(ChatMessageRecord {
                        id: make_id("message"),
                        session_id: wander_session_id.clone(),
                        role: "user".to_string(),
                        content: prompt.clone(),
                        display_content: None,
                        attachment: None,
                        metadata: None,
                        created_at: now_iso(),
                    });
                    store.chat_messages.push(ChatMessageRecord {
                        id: make_id("message"),
                        session_id: wander_session_id.clone(),
                        role: "assistant".to_string(),
                        content: model_result.clone(),
                        display_content: None,
                        attachment: None,
                        metadata: None,
                        created_at: now_iso(),
                    });
                    append_session_transcript(
                        store,
                        &wander_session_id,
                        "message",
                        "user",
                        prompt.clone(),
                        Some(json!({ "source": "wander" })),
                    );
                    append_session_transcript(
                        store,
                        &wander_session_id,
                        "message",
                        "assistant",
                        model_result.clone(),
                        Some(json!({ "source": "wander" })),
                    );
                    append_session_checkpoint(
                        store,
                        &wander_session_id,
                        "wander-brainstorm",
                        "Wander brainstorm completed".to_string(),
                        Some(json!({ "responsePreview": text_snippet(&result_text, 160) })),
                    );
                    store.wander_history.push(WanderHistoryRecord {
                        id: history_id.clone(),
                        items: serde_json::to_string(&items).map_err(|error| error.to_string())?,
                        result: result_text.clone(),
                        created_at: now_i64(),
                    });
                    Ok(())
                })?;
                log_timing_event(
                    state,
                    "wander",
                    &request_id,
                    "history-saved",
                    history_started_at,
                    Some(format!("historyId={}", history_id)),
                );
                let _ = app.emit(
                    "wander:progress",
                    json!({
                        "requestId": request_id.clone(),
                        "sessionId": wander_session_id.clone(),
                        "phase": "complete",
                        "stepIndex": 3,
                        "totalSteps": 3,
                        "title": "保存结果",
                        "status": "completed",
                        "detail": "漫步完成，结果已写入历史记录。",
                    }),
                );
                log_timing_event(
                    state,
                    "wander",
                    &request_id,
                    "request-complete",
                    request_started_at,
                    Some(format!("sessionId={}", wander_session_id)),
                );
                Ok(json!({ "result": result_text, "historyId": history_id, "items": items }))
            }
            _ => Err(format!(
                "{} host does not recognize channel `{channel}`.",
                app_brand_display_name()
            )),
        }
    })())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_wander_result_keeps_partial_multi_choice_without_duplication() {
        let result = normalize_wander_result(
            json!({
                "options": [
                    {
                        "content_direction": "给正在做内容的人一个更锋利的选题切口。",
                        "direction_frame": {
                            "target_reader": "刚开始做内容的人",
                            "core_tension": "总想等自己更厉害再开始",
                            "angle": "用15度角法则拆掉启动门槛",
                            "material_entry": "借素材里的延迟开工困境做切口"
                        },
                        "topic": {
                            "title": "别等变厉害再开始",
                            "connections": [1]
                        }
                    }
                ]
            }),
            true,
        );

        let options = result["options"].as_array().expect("options");
        assert_eq!(options.len(), 1);
    }

    #[test]
    fn lightweight_image_attachment_persists_thumbnail_url() {
        let path =
            std::env::temp_dir().join(format!("redbox-chat-image-preview-test-{}.jpg", now_ms()));
        fs::write(&path, b"fake-image-bytes").expect("write temp image");

        let attachment =
            lightweight_image_attachment_value_for_path(&path, fs::metadata(&path).unwrap().len());

        let thumbnail_url = attachment
            .get("thumbnailUrl")
            .and_then(Value::as_str)
            .unwrap_or_default();
        assert!(thumbnail_url.starts_with("data:image/jpeg;base64,"));
        assert_eq!(
            attachment.get("thumbnailDataUrl").and_then(Value::as_str),
            Some(thumbnail_url)
        );

        let _ = fs::remove_file(path);
    }

    #[test]
    fn normalize_wander_result_synthesizes_direction_from_frame() {
        let result = normalize_wander_result(
            json!({
                "direction_frame": {
                    "target_reader": "想做 side project 但不敢发布的独立开发者",
                    "core_tension": "担心被抄所以不敢发布 vs 不发布永远不知道想法好不好",
                    "angle": "把发布产品变成一次低成本的自我表达实验",
                    "material_entry": "母版是高赞素材，借一个具体动作做切口"
                },
                "topic": {
                    "title": "怕被抄？你的想法还没资格被抄",
                    "connections": [1, 2]
                }
            }),
            false,
        );

        let direction = result
            .get("content_direction")
            .and_then(Value::as_str)
            .unwrap_or_default();
        assert!(direction.contains("想做 side project"));
        assert!(direction.contains("低成本的自我表达实验"));
        assert!(collect_wander_validation_issues(&result, false).is_empty());
    }

    #[test]
    fn collect_wander_validation_issues_reports_missing_direction_frame_fields() {
        let issues = collect_wander_validation_issues(
            &json!({
                "content_direction": "这是一个方向。",
                "direction_frame": {
                    "target_reader": "",
                    "core_tension": "",
                    "angle": "",
                    "material_entry": ""
                },
                "topic": {
                    "title": "一个标题",
                    "connections": [1]
                }
            }),
            false,
        );

        let codes = issues
            .iter()
            .filter_map(|item| item.get("code").and_then(Value::as_str))
            .collect::<Vec<_>>();
        assert!(codes.contains(&"missing_target_reader"));
        assert!(codes.contains(&"missing_core_tension"));
        assert!(codes.contains(&"missing_angle"));
        assert!(codes.contains(&"missing_material_entry"));
    }

    #[test]
    fn collect_wander_validation_issues_rejects_template_title_and_direction() {
        let issues = collect_wander_validation_issues(
            &json!({
                "content_direction": "围绕素材提炼一个可执行的内容方向。",
                "direction_frame": {
                    "target_reader": "AI 创作者",
                    "core_tension": "想做内容但没有抓手",
                    "angle": "从等待变厉害转向先行动",
                    "material_entry": "借一条素材的开头张力"
                },
                "topic": {
                    "title": "从某素材延展出的内容选题",
                    "connections": [1]
                }
            }),
            false,
        );

        let codes = issues
            .iter()
            .filter_map(|item| item.get("code").and_then(Value::as_str))
            .collect::<Vec<_>>();
        assert!(codes.contains(&"generic_title"));
        assert!(codes.contains(&"generic_direction"));
    }

    #[test]
    fn build_wander_task_prompt_delegates_flow_to_skill() {
        let prompt = build_wander_task_prompt(
            "Item 1",
            "素材 1 | 标题: 示例\n- 预读正文:\n这里是宿主预读的内容",
            "素材 1 | workspace 路径: knowledge/redbook/demo",
            false,
        );

        assert!(prompt.contains("wander-synthesis"));
        assert!(prompt.contains("xhs-title"));
        assert!(prompt.contains("topic.title 必须先按 `xhs-title`"));
        assert!(prompt.contains("likes 最高的素材作为母版"));
        assert!(prompt.contains("不要把三条素材硬串成一个大主题"));
        assert!(prompt.contains("越细、越小、越具体"));
        assert!(prompt.contains("宿主预读素材包"));
        assert!(prompt.contains("只使用本轮素材"));
        assert!(!prompt.contains("至少发起 1 次工具调用"));
        assert!(!prompt.contains("用户长期上下文"));
        assert!(!prompt.contains("MEMORY.md"));
        assert!(!prompt.contains("爆款方法"));
        assert!(!prompt.contains("隐藏连接"));
    }

    #[test]
    fn pick_random_wander_items_fills_from_recent_when_unseen_are_insufficient() {
        let items = vec![
            json!({ "id": "recent-a", "title": "最近用过 A" }),
            json!({ "id": "fresh", "title": "未用过" }),
            json!({ "id": "recent-b", "title": "最近用过 B" }),
        ];
        let excluded_ids = HashSet::from(["recent-a".to_string(), "recent-b".to_string()]);

        let picked = pick_random_wander_items(items, 3, &excluded_ids);
        let picked_ids = picked
            .iter()
            .filter_map(|item| item.get("id").and_then(Value::as_str))
            .collect::<HashSet<_>>();

        assert_eq!(picked.len(), 3);
        assert!(picked_ids.contains("fresh"));
        assert!(picked_ids.contains("recent-a") || picked_ids.contains("recent-b"));
    }

    #[test]
    fn compose_guided_wander_items_keeps_anchor_and_filters_by_direction() {
        let mut store = AppStore::default();
        store.knowledge_notes = vec![
            KnowledgeNoteRecord {
                id: "note-fasting-1".to_string(),
                r#type: None,
                source_domain: None,
                source_link: None,
                source_url: None,
                title: "轻断食反弹后怎么重新开始".to_string(),
                author: "tester".to_string(),
                author_id: None,
                author_url: None,
                author_avatar_url: None,
                author_description: None,
                content: "减脂失败、暴食和反弹后的复盘。".to_string(),
                excerpt: None,
                site_name: None,
                capture_kind: Some("note".to_string()),
                html_file: None,
                html_file_url: None,
                images: Vec::new(),
                tags: Some(vec!["轻断食".to_string(), "减脂".to_string()]),
                cover: None,
                video: None,
                video_url: None,
                transcript: None,
                transcription_status: None,
                stats: KnowledgeNoteStatsRecord {
                    likes: 0,
                    collects: None,
                },
                created_at: "2026-04-27T00:00:00Z".to_string(),
                folder_path: None,
            },
            KnowledgeNoteRecord {
                id: "note-fasting-2".to_string(),
                r#type: None,
                source_domain: None,
                source_link: None,
                source_url: None,
                title: "减脂期暴食不是意志力差".to_string(),
                author: "tester".to_string(),
                author_id: None,
                author_url: None,
                author_avatar_url: None,
                author_description: None,
                content: "轻断食后报复性进食导致体重反弹。".to_string(),
                excerpt: None,
                site_name: None,
                capture_kind: Some("note".to_string()),
                html_file: None,
                html_file_url: None,
                images: Vec::new(),
                tags: Some(vec!["暴食".to_string(), "反弹".to_string()]),
                cover: None,
                video: None,
                video_url: None,
                transcript: None,
                transcription_status: None,
                stats: KnowledgeNoteStatsRecord {
                    likes: 0,
                    collects: None,
                },
                created_at: "2026-04-27T00:00:00Z".to_string(),
                folder_path: None,
            },
            KnowledgeNoteRecord {
                id: "note-unrelated".to_string(),
                r#type: None,
                source_domain: None,
                source_link: None,
                source_url: None,
                title: "春季穿搭和口红颜色".to_string(),
                author: "tester".to_string(),
                author_id: None,
                author_url: None,
                author_avatar_url: None,
                author_description: None,
                content: "通勤穿搭、配饰和妆容。".to_string(),
                excerpt: None,
                site_name: None,
                capture_kind: Some("note".to_string()),
                html_file: None,
                html_file_url: None,
                images: Vec::new(),
                tags: Some(vec!["穿搭".to_string()]),
                cover: None,
                video: None,
                video_url: None,
                transcript: None,
                transcription_status: None,
                stats: KnowledgeNoteStatsRecord {
                    likes: 0,
                    collects: None,
                },
                created_at: "2026-04-27T00:00:00Z".to_string(),
                folder_path: None,
            },
        ];

        let response = compose_guided_wander_items(
            &store,
            &json!({
                "topic": "轻断食反弹",
                "seedText": "最近减脂后暴食，想写失败复盘",
                "anchorItem": {
                    "id": "anchor-note",
                    "type": "note",
                    "title": "我的轻断食经历",
                    "content": "断食之后反弹，很挫败。"
                },
                "targetCount": 3
            }),
        );

        let items = response["items"].as_array().expect("items");
        let ids = items
            .iter()
            .filter_map(|item| item.get("id").and_then(Value::as_str))
            .collect::<Vec<_>>();
        assert_eq!(ids.first(), Some(&"anchor-note"));
        assert!(ids.contains(&"note-fasting-1"));
        assert!(ids.contains(&"note-fasting-2"));
        assert!(!ids.contains(&"note-unrelated"));
    }
}
