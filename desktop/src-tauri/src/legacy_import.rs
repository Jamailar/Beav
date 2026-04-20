use rusqlite::Connection;
use serde_json::{Value, json};
use std::fs;
use std::path::{Path, PathBuf};

use crate::{
    AppStore, ArchiveProfileRecord, ArchiveSampleRecord, ChatMessageRecord, ChatSessionRecord,
    SessionCheckpointRecord, SessionToolResultRecord, SessionTranscriptRecord, SpaceRecord,
    UserMemoryRecord, WanderHistoryRecord, compatible_workspace_base_dir, configured_workspace_dir,
    copy_dir_recursive, file_url_for_path, hydrate_store_from_workspace_files, is_same_path,
    legacy_workspace_dir, now_iso,
};

pub(crate) fn legacy_db_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(home_dir) = dirs::home_dir() {
        let mac_base = home_dir.join("Library").join("Application Support");
        candidates.extend([
            mac_base.join("red-convert-desktop").join("redconvert.db"),
            mac_base.join("redbox-desktop").join("redconvert.db"),
            mac_base.join("Electron").join("redconvert.db"),
        ]);
    }
    if let Some(data_dir) = dirs::data_dir() {
        candidates.extend([
            data_dir.join("red-convert-desktop").join("redconvert.db"),
            data_dir.join("redbox-desktop").join("redconvert.db"),
            data_dir.join("Electron").join("redconvert.db"),
        ]);
    }
    candidates
}

pub(crate) fn run_sqlite_json_lines(db_path: &Path, sql: &str) -> Result<Vec<Value>, String> {
    let connection = Connection::open(db_path).map_err(|error| error.to_string())?;
    let mut statement = connection.prepare(sql).map_err(|error| error.to_string())?;
    let rows_iter = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?;
    let mut rows = Vec::new();
    for line in rows_iter {
        let line = line.map_err(|error| error.to_string())?;
        let line = line.trim().to_string();
        if line.is_empty() {
            continue;
        }
        if let Ok(value) = serde_json::from_str::<Value>(&line) {
            rows.push(value);
        }
    }
    Ok(rows)
}

pub(crate) fn sqlite_count(db_path: &Path, table: &str) -> i64 {
    let sql = format!("select json_object('count', count(*)) from {table};");
    run_sqlite_json_lines(db_path, &sql)
        .ok()
        .and_then(|rows| rows.into_iter().next())
        .and_then(|value| value.get("count").and_then(|v| v.as_i64()))
        .unwrap_or(0)
}

pub(crate) fn detect_best_legacy_db() -> Option<PathBuf> {
    let mut best: Option<(PathBuf, i64)> = None;
    for path in legacy_db_candidates()
        .into_iter()
        .filter(|path| path.exists())
    {
        let score = sqlite_count(&path, "chat_sessions")
            + sqlite_count(&path, "chat_messages")
            + sqlite_count(&path, "archive_profiles")
            + sqlite_count(&path, "archive_samples")
            + sqlite_count(&path, "settings");
        if score <= 0 {
            continue;
        }
        match &best {
            Some((_, current_score)) if *current_score >= score => {}
            _ => best = Some((path, score)),
        }
    }
    best.map(|(path, _)| path)
}

#[allow(dead_code)]
pub(crate) fn legacy_workspace_dir_from_store(store: &AppStore, db_path: &Path) -> Option<PathBuf> {
    let direct = configured_workspace_dir(&store.settings);
    if direct.as_ref().is_some_and(|path| path.exists()) {
        return direct;
    }
    let rows = run_sqlite_json_lines(
        db_path,
        "select json_object('workspace_dir', workspace_dir) from settings limit 1;",
    )
    .ok()?;
    rows.into_iter()
        .next()
        .and_then(|value| configured_workspace_dir(&value))
        .filter(|path| path.exists())
}

#[allow(dead_code)]
pub(crate) fn legacy_workspace_root_candidates(
    store: &AppStore,
    db_path: Option<&Path>,
) -> Vec<PathBuf> {
    let mut candidates = Vec::<PathBuf>::new();
    if let Some(db_path) = db_path {
        if let Some(path) = legacy_workspace_dir_from_store(store, db_path) {
            candidates.push(path);
        }
    }
    if let Some(legacy) = legacy_workspace_dir() {
        candidates.push(legacy);
    }
    let app_support = dirs::data_dir().or_else(dirs::config_dir);
    if let Some(app_support) = app_support {
        candidates.push(app_support.join("red-convert-desktop"));
        candidates.push(app_support.join("redbox-desktop"));
    }
    let mut deduped = Vec::new();
    for path in candidates {
        if path.exists() && !deduped.iter().any(|existing: &PathBuf| existing == &path) {
            deduped.push(path);
        }
    }
    deduped
}

#[allow(dead_code)]
pub(crate) fn directory_has_entries(path: &Path) -> bool {
    fs::read_dir(path)
        .ok()
        .and_then(|mut entries| entries.next())
        .is_some()
}

pub(crate) fn normalize_legacy_workspace_path(path: &Path) -> PathBuf {
    let raw = path.display().to_string();
    if path.exists() {
        return path.to_path_buf();
    }
    if raw.contains("/.redbox/") || raw.ends_with("/.redbox") {
        let legacy = PathBuf::from(raw.replace("/.redbox", "/.redconvert"));
        if legacy.exists() {
            return legacy;
        }
    }
    path.to_path_buf()
}

pub(crate) fn optional_asset_url_from_note_path(
    base_dir: &Path,
    raw: Option<&Value>,
) -> Option<String> {
    let raw = raw
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|v| !v.is_empty())?;
    let candidate = PathBuf::from(raw);
    let absolute = if candidate.is_absolute() {
        normalize_legacy_workspace_path(&candidate)
    } else {
        normalize_legacy_workspace_path(&base_dir.join(candidate))
    };
    if absolute.exists() {
        Some(file_url_for_path(&absolute))
    } else {
        None
    }
}

pub(crate) fn extract_tags_from_text(text: &str) -> Vec<String> {
    let mut tags = Vec::new();
    for token in text.split('#').skip(1) {
        let candidate = token
            .lines()
            .next()
            .unwrap_or("")
            .split_whitespace()
            .next()
            .unwrap_or("")
            .trim_matches(|c: char| {
                c == '#'
                    || c == '，'
                    || c == ','
                    || c == '。'
                    || c == '.'
                    || c == '！'
                    || c == '!'
                    || c == '？'
                    || c == '?'
            })
            .trim();
        if !candidate.is_empty() {
            let normalized = candidate.to_string();
            if !tags.iter().any(|item| item == &normalized) {
                tags.push(normalized);
            }
        }
    }
    tags
}

#[allow(dead_code)]
pub(crate) fn migrate_legacy_workspace_dirs(
    target_root: &Path,
    legacy_root: &Path,
) -> Result<(), String> {
    for name in [
        "manuscripts",
        "knowledge",
        "media",
        "cover",
        "redclaw",
        "subjects",
        "chatrooms",
        "advisors",
        "archives",
        "memory",
        "skills",
    ] {
        let source = legacy_root.join(name);
        if !source.exists() {
            continue;
        }
        let target = target_root.join(name);
        if directory_has_entries(&target) {
            continue;
        }
        copy_dir_recursive(&source, &target)?;
    }
    for extra_file in ["manuscript-layouts.json"] {
        let source = legacy_root.join(extra_file);
        let target = target_root.join(extra_file);
        if source.is_file() && !target.exists() {
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            }
            fs::copy(&source, &target).map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

#[allow(dead_code)]
pub(crate) fn ensure_preferred_workspace_dir(
    store: &mut AppStore,
    _store_path: &Path,
) -> Result<PathBuf, String> {
    let chosen = compatible_workspace_base_dir(&store.settings);
    if !is_same_path(
        &chosen,
        &legacy_workspace_dir().unwrap_or_else(|| PathBuf::from("__redbox_missing_legacy__")),
    ) {
        if let Some(parent) = chosen.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        fs::create_dir_all(&chosen).map_err(|error| error.to_string())?;
    }

    let settings_obj = store
        .settings
        .as_object_mut()
        .ok_or_else(|| "settings should be a JSON object".to_string())?;
    settings_obj.insert(
        "workspace_dir".to_string(),
        json!(chosen.display().to_string()),
    );
    Ok(chosen)
}

pub(crate) fn maybe_import_legacy_store(
    store: &mut AppStore,
    store_path: &Path,
) -> Result<(), String> {
    let db_path = detect_best_legacy_db().ok_or_else(|| "legacy database not found".to_string())?;

    if !store.settings.is_object() {
        store.settings = json!({});
    }

    let settings_rows = run_sqlite_json_lines(
        &db_path,
        "select json_object('api_endpoint', api_endpoint, 'api_key', api_key, 'model_name', model_name, 'role_mapping', role_mapping, 'workspace_dir', workspace_dir, 'transcription_model', transcription_model, 'transcription_endpoint', transcription_endpoint, 'transcription_key', transcription_key, 'embedding_endpoint', embedding_endpoint, 'embedding_key', embedding_key, 'embedding_model', embedding_model, 'active_space_id', active_space_id, 'image_provider', image_provider, 'image_endpoint', image_endpoint, 'image_api_key', image_api_key, 'image_model', image_model, 'image_size', image_size, 'image_quality', image_quality, 'ai_sources_json', ai_sources_json, 'default_ai_source_id', default_ai_source_id, 'mcp_servers_json', mcp_servers_json, 'redclaw_compact_target_tokens', redclaw_compact_target_tokens, 'image_provider_template', image_provider_template, 'image_aspect_ratio', image_aspect_ratio, 'wander_deep_think_enabled', wander_deep_think_enabled, 'chat_max_tokens_default', chat_max_tokens_default, 'chat_max_tokens_deepseek', chat_max_tokens_deepseek, 'model_name_wander', model_name_wander, 'model_name_chatroom', model_name_chatroom, 'model_name_knowledge', model_name_knowledge, 'model_name_redclaw', model_name_redclaw, 'debug_log_enabled', debug_log_enabled, 'developer_mode_enabled', developer_mode_enabled, 'developer_mode_unlocked_at', developer_mode_unlocked_at, 'search_provider', search_provider, 'search_endpoint', search_endpoint, 'search_api_key', search_api_key, 'video_endpoint', video_endpoint, 'video_api_key', video_api_key, 'video_model', video_model, 'proxy_enabled', proxy_enabled, 'proxy_url', proxy_url, 'proxy_bypass', proxy_bypass) from settings limit 1;",
    )?;
    if let Some(first) = settings_rows.into_iter().next() {
        if let (Some(current), Some(next)) = (store.settings.as_object_mut(), first.as_object()) {
            for (key, value) in next {
                current.insert(key.to_string(), value.clone());
            }
        } else {
            store.settings = first.clone();
        }
        if let Some(active_space_id) = first
            .get("active_space_id")
            .and_then(|value| value.as_str())
        {
            let trimmed = active_space_id.trim();
            if !trimmed.is_empty() {
                store.active_space_id = trimmed.to_string();
            }
        }
    }

    if store.spaces.len() <= 1 {
        let rows = run_sqlite_json_lines(
            &db_path,
            "select json_object('id', id, 'name', name, 'created_at', cast(created_at as text), 'updated_at', cast(updated_at as text)) from spaces order by updated_at desc;",
        )?;
        let mut imported_spaces = Vec::new();
        for value in rows {
            let id = value
                .get("id")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .trim()
                .to_string();
            if id.is_empty() {
                continue;
            }
            imported_spaces.push(SpaceRecord {
                id,
                name: value
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("未命名空间")
                    .to_string(),
                created_at: value
                    .get("created_at")
                    .and_then(|v| v.as_str())
                    .unwrap_or("0")
                    .to_string(),
                updated_at: value
                    .get("updated_at")
                    .and_then(|v| v.as_str())
                    .unwrap_or("0")
                    .to_string(),
            });
        }
        if !imported_spaces.is_empty() {
            store.spaces = imported_spaces;
        }
    }

    if store.chat_sessions.is_empty() {
        let rows = run_sqlite_json_lines(
            &db_path,
            "select json_object('id', id, 'title', coalesce(title, 'New Chat'), 'created_at', cast(created_at as text), 'updated_at', cast(updated_at as text), 'metadata', json(metadata)) from chat_sessions order by updated_at desc;",
        )?;
        for value in rows {
            let metadata = value.get("metadata").cloned().filter(|v| !v.is_null());
            store.chat_sessions.push(ChatSessionRecord {
                id: value
                    .get("id")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string(),
                title: value
                    .get("title")
                    .and_then(|v| v.as_str())
                    .unwrap_or("New Chat")
                    .to_string(),
                created_at: value
                    .get("created_at")
                    .and_then(|v| v.as_str())
                    .unwrap_or("0")
                    .to_string(),
                updated_at: value
                    .get("updated_at")
                    .and_then(|v| v.as_str())
                    .unwrap_or("0")
                    .to_string(),
                metadata,
            });
        }
    }

    if store.chat_messages.is_empty() {
        let rows = run_sqlite_json_lines(
            &db_path,
            "select json_object('id', id, 'session_id', session_id, 'role', role, 'content', content, 'timestamp', timestamp) from chat_messages order by timestamp asc;",
        )?;
        for value in rows {
            let session_id = value
                .get("session_id")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            let role = value
                .get("role")
                .and_then(|v| v.as_str())
                .unwrap_or("assistant")
                .to_string();
            let content = value
                .get("content")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            let ts = value.get("timestamp").and_then(|v| v.as_i64()).unwrap_or(0);
            store.chat_messages.push(ChatMessageRecord {
                id: value
                    .get("id")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string(),
                session_id,
                role,
                content,
                display_content: None,
                attachment: None,
                created_at: ts.to_string(),
            });
        }
    }

    if store.session_transcript_records.is_empty() {
        let rows = run_sqlite_json_lines(
            &db_path,
            "select json_object('id', id, 'session_id', session_id, 'record_type', record_type, 'role', role, 'content', content, 'payload', json(payload_json), 'created_at', created_at) from session_transcript_records order by created_at asc;",
        )?;
        for value in rows {
            store
                .session_transcript_records
                .push(SessionTranscriptRecord {
                    id: value
                        .get("id")
                        .and_then(|v| v.as_str())
                        .unwrap_or_default()
                        .to_string(),
                    session_id: value
                        .get("session_id")
                        .and_then(|v| v.as_str())
                        .unwrap_or_default()
                        .to_string(),
                    record_type: value
                        .get("record_type")
                        .and_then(|v| v.as_str())
                        .unwrap_or("message")
                        .to_string(),
                    role: value
                        .get("role")
                        .and_then(|v| v.as_str())
                        .unwrap_or("assistant")
                        .to_string(),
                    content: value
                        .get("content")
                        .and_then(|v| v.as_str())
                        .unwrap_or_default()
                        .to_string(),
                    payload: value.get("payload").cloned().filter(|v| !v.is_null()),
                    created_at: value
                        .get("created_at")
                        .and_then(|v| v.as_i64())
                        .unwrap_or(0),
                });
        }
    }

    if store.session_checkpoints.is_empty() {
        let rows = run_sqlite_json_lines(
            &db_path,
            "select json_object('id', id, 'session_id', session_id, 'checkpoint_type', checkpoint_type, 'summary', summary, 'payload', json(payload_json), 'created_at', created_at) from session_checkpoints order by created_at asc;",
        )?;
        for value in rows {
            store.session_checkpoints.push(SessionCheckpointRecord {
                id: value
                    .get("id")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string(),
                session_id: value
                    .get("session_id")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string(),
                runtime_id: None,
                parent_runtime_id: None,
                source_task_id: None,
                checkpoint_type: value
                    .get("checkpoint_type")
                    .and_then(|v| v.as_str())
                    .unwrap_or("checkpoint")
                    .to_string(),
                summary: value
                    .get("summary")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string(),
                payload: value.get("payload").cloned().filter(|v| !v.is_null()),
                created_at: value
                    .get("created_at")
                    .and_then(|v| v.as_i64())
                    .unwrap_or(0),
            });
        }
    }

    if store.session_tool_results.is_empty() {
        let rows = run_sqlite_json_lines(
            &db_path,
            "select json_object('id', id, 'session_id', session_id, 'call_id', call_id, 'tool_name', tool_name, 'command', command, 'success', success, 'result_text', result_text, 'summary_text', summary_text, 'prompt_text', prompt_text, 'original_chars', original_chars, 'prompt_chars', prompt_chars, 'truncated', truncated, 'payload', json(payload_json), 'created_at', created_at, 'updated_at', updated_at) from session_tool_results order by created_at asc;",
        )?;
        for value in rows {
            store.session_tool_results.push(SessionToolResultRecord {
                id: value
                    .get("id")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string(),
                session_id: value
                    .get("session_id")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string(),
                runtime_id: None,
                parent_runtime_id: None,
                source_task_id: None,
                call_id: value
                    .get("call_id")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string(),
                tool_name: value
                    .get("tool_name")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string(),
                command: value
                    .get("command")
                    .and_then(|v| v.as_str())
                    .map(ToString::to_string),
                success: value.get("success").and_then(|v| v.as_i64()).unwrap_or(0) != 0,
                result_text: value
                    .get("result_text")
                    .and_then(|v| v.as_str())
                    .map(ToString::to_string),
                summary_text: value
                    .get("summary_text")
                    .and_then(|v| v.as_str())
                    .map(ToString::to_string),
                prompt_text: value
                    .get("prompt_text")
                    .and_then(|v| v.as_str())
                    .map(ToString::to_string),
                original_chars: value.get("original_chars").and_then(|v| v.as_i64()),
                prompt_chars: value.get("prompt_chars").and_then(|v| v.as_i64()),
                truncated: value.get("truncated").and_then(|v| v.as_i64()).unwrap_or(0) != 0,
                payload: value.get("payload").cloned().filter(|v| !v.is_null()),
                created_at: value
                    .get("created_at")
                    .and_then(|v| v.as_i64())
                    .unwrap_or(0),
                updated_at: value
                    .get("updated_at")
                    .and_then(|v| v.as_i64())
                    .unwrap_or(0),
            });
        }
    }

    if store.wander_history.is_empty() {
        let rows = run_sqlite_json_lines(
            &db_path,
            "select json_object('id', id, 'items', items, 'result', result, 'created_at', created_at) from wander_history order by created_at desc;",
        )?;
        for value in rows {
            store.wander_history.push(WanderHistoryRecord {
                id: value
                    .get("id")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string(),
                items: value
                    .get("items")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string(),
                result: value
                    .get("result")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string(),
                created_at: value
                    .get("created_at")
                    .and_then(|v| v.as_i64())
                    .unwrap_or(0),
            });
        }
    }

    if store.memories.is_empty() {
        let rows = run_sqlite_json_lines(
            &db_path,
            "select json_object('id', id, 'content', content, 'type', type, 'tags', coalesce(tags, '[]'), 'created_at', created_at, 'updated_at', updated_at, 'last_accessed', last_accessed) from user_memories order by updated_at desc;",
        )?;
        for value in rows {
            let tags = value
                .get("tags")
                .and_then(|v| v.as_str())
                .and_then(|text| serde_json::from_str::<Vec<String>>(text).ok())
                .unwrap_or_default();
            store.memories.push(UserMemoryRecord {
                id: value
                    .get("id")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string(),
                content: value
                    .get("content")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string(),
                r#type: value
                    .get("type")
                    .and_then(|v| v.as_str())
                    .unwrap_or("general")
                    .to_string(),
                tags,
                created_at: value
                    .get("created_at")
                    .and_then(|v| v.as_i64())
                    .unwrap_or(0),
                updated_at: value.get("updated_at").and_then(|v| v.as_i64()),
                last_accessed: value.get("last_accessed").and_then(|v| v.as_i64()),
                status: None,
                archived_at: None,
                archive_reason: None,
                origin_id: None,
                canonical_key: None,
                revision: None,
                last_conflict_at: None,
            });
        }
    }

    if store.archive_profiles.is_empty() {
        let rows = run_sqlite_json_lines(
            &db_path,
            "select json_object('id', id, 'name', name, 'platform', platform, 'goal', goal, 'domain', domain, 'audience', audience, 'tone_tags', coalesce(tone_tags, '[]'), 'created_at', created_at, 'updated_at', updated_at) from archive_profiles order by updated_at desc;",
        )?;
        for value in rows {
            let tags = value
                .get("tone_tags")
                .and_then(|v| v.as_str())
                .and_then(|text| serde_json::from_str::<Vec<String>>(text).ok())
                .unwrap_or_default();
            store.archive_profiles.push(ArchiveProfileRecord {
                id: value
                    .get("id")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string(),
                name: value
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("未命名档案")
                    .to_string(),
                platform: value
                    .get("platform")
                    .and_then(|v| v.as_str())
                    .map(ToString::to_string),
                goal: value
                    .get("goal")
                    .and_then(|v| v.as_str())
                    .map(ToString::to_string),
                domain: value
                    .get("domain")
                    .and_then(|v| v.as_str())
                    .map(ToString::to_string),
                audience: value
                    .get("audience")
                    .and_then(|v| v.as_str())
                    .map(ToString::to_string),
                tone_tags: tags,
                created_at: value
                    .get("created_at")
                    .and_then(|v| v.as_i64())
                    .unwrap_or(0),
                updated_at: value
                    .get("updated_at")
                    .and_then(|v| v.as_i64())
                    .unwrap_or(0),
            });
        }
    }

    if store.archive_samples.is_empty() {
        let rows = run_sqlite_json_lines(
            &db_path,
            "select json_object('id', id, 'profile_id', profile_id, 'title', title, 'content', content, 'excerpt', excerpt, 'tags', coalesce(tags, '[]'), 'images', coalesce(images, '[]'), 'platform', platform, 'source_url', source_url, 'sample_date', sample_date, 'is_featured', is_featured, 'created_at', created_at) from archive_samples order by created_at desc;",
        )?;
        for value in rows {
            let tags = value
                .get("tags")
                .and_then(|v| v.as_str())
                .and_then(|text| serde_json::from_str::<Vec<String>>(text).ok())
                .unwrap_or_default();
            let images = value
                .get("images")
                .and_then(|v| v.as_str())
                .and_then(|text| serde_json::from_str::<Vec<String>>(text).ok())
                .unwrap_or_default();
            store.archive_samples.push(ArchiveSampleRecord {
                id: value
                    .get("id")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string(),
                profile_id: value
                    .get("profile_id")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string(),
                title: value
                    .get("title")
                    .and_then(|v| v.as_str())
                    .map(ToString::to_string),
                content: value
                    .get("content")
                    .and_then(|v| v.as_str())
                    .map(ToString::to_string),
                excerpt: value
                    .get("excerpt")
                    .and_then(|v| v.as_str())
                    .map(ToString::to_string),
                tags,
                images,
                platform: value
                    .get("platform")
                    .and_then(|v| v.as_str())
                    .map(ToString::to_string),
                source_url: value
                    .get("source_url")
                    .and_then(|v| v.as_str())
                    .map(ToString::to_string),
                sample_date: value
                    .get("sample_date")
                    .and_then(|v| v.as_str())
                    .map(ToString::to_string),
                is_featured: value
                    .get("is_featured")
                    .and_then(|v| v.as_i64())
                    .unwrap_or(0),
                created_at: value
                    .get("created_at")
                    .and_then(|v| v.as_i64())
                    .unwrap_or(0),
            });
        }
    }

    if !store
        .spaces
        .iter()
        .any(|space| space.id == store.active_space_id)
    {
        store.active_space_id = "default".to_string();
    }
    if store.active_space_id.trim().is_empty() {
        store.active_space_id = "default".to_string();
    }

    store.legacy_imported_at = Some(now_iso());
    store.legacy_import_source = Some(db_path.display().to_string());
    let _ = hydrate_store_from_workspace_files(store, store_path);
    Ok(())
}
