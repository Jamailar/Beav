use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};

use crate::{
    configured_workspace_dir, copy_dir_recursive, ensure_workspace_dirs, file_url_for_path,
    hydrate_store_from_workspace_files, is_same_path, legacy_workspace_dir,
    managed_workspace_dir_candidates, now_iso, preferred_workspace_dir,
    should_force_preferred_workspace_dir, slug_from_relative_path, AppStore, ArchiveProfileRecord,
    ArchiveSampleRecord, ChatMessageRecord, ChatSessionRecord, SessionTranscriptRecord,
    SpaceRecord,
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
    let output = std::process::Command::new("sqlite3")
        .arg(db_path)
        .arg(sql)
        .output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!("sqlite3 failed with status {}", output.status)
        } else {
            stderr
        });
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut rows = Vec::new();
    for line in stdout
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
    {
        if let Ok(value) = serde_json::from_str::<Value>(line) {
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

pub(crate) fn directory_has_entries(path: &Path) -> bool {
    fs::read_dir(path)
        .ok()
        .and_then(|mut entries| entries.next())
        .is_some()
}

pub(crate) fn normalize_legacy_workspace_path(path: &Path) -> PathBuf {
    let raw = path.display().to_string();
    if raw.contains("/.redconvert/") || raw.ends_with("/.redconvert") {
        return PathBuf::from(raw.replace("/.redconvert", "/.redbox"));
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

pub(crate) fn ensure_preferred_workspace_dir(
    store: &mut AppStore,
    store_path: &Path,
) -> Result<PathBuf, String> {
    let preferred = preferred_workspace_dir();
    if let Some(parent) = preferred.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }

    if !preferred.exists() {
        if let Some(legacy) = legacy_workspace_dir().filter(|path| path.exists()) {
            if fs::rename(&legacy, &preferred).is_err() {
                copy_dir_recursive(&legacy, &preferred)?;
            }
        }
    }

    let configured = configured_workspace_dir(&store.settings);
    let chosen = if should_force_preferred_workspace_dir(configured.as_deref(), store_path) {
        preferred
    } else {
        configured.unwrap_or_else(preferred_workspace_dir)
    };

    if let Some(parent) = chosen.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::create_dir_all(&chosen).map_err(|error| error.to_string())?;

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
    let db_path = detect_best_legacy_db();

    if let Some(db_path) = db_path.as_ref() {
        if store.settings == json!({}) {
            let rows = run_sqlite_json_lines(
                db_path,
                "select json_object('api_endpoint', api_endpoint, 'api_key', api_key, 'model_name', model_name, 'role_mapping', role_mapping, 'workspace_dir', workspace_dir, 'transcription_model', transcription_model, 'transcription_endpoint', transcription_endpoint, 'transcription_key', transcription_key, 'embedding_endpoint', embedding_endpoint, 'embedding_key', embedding_key, 'embedding_model', embedding_model) from settings limit 1;",
            )?;
            if let Some(first) = rows.into_iter().next() {
                store.settings = first;
            }
        }

        if store.chat_sessions.is_empty() {
            let rows = run_sqlite_json_lines(
                db_path,
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
                db_path,
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
                    session_id: session_id.clone(),
                    role: role.clone(),
                    content: content.clone(),
                    display_content: None,
                    attachment: None,
                    created_at: ts.to_string(),
                });
                store
                    .session_transcript_records
                    .push(SessionTranscriptRecord {
                        id: format!(
                            "legacy-transcript-{}",
                            value.get("id").and_then(|v| v.as_str()).unwrap_or_default()
                        ),
                        session_id,
                        record_type: "message".to_string(),
                        role,
                        content,
                        payload: None,
                        created_at: ts,
                    });
            }
        }

        if store.archive_profiles.is_empty() {
            let rows = run_sqlite_json_lines(
                db_path,
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
                db_path,
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
    }

    let workspace_base = ensure_preferred_workspace_dir(store, store_path)?;
    let store_root = store_path
        .parent()
        .ok_or_else(|| "RedBox store root is unavailable".to_string())?;
    let default_space_root = workspace_base.clone();
    ensure_workspace_dirs(&default_space_root)?;

    for managed_root in managed_workspace_dir_candidates(store_path) {
        if managed_root.exists() {
            let _ = migrate_legacy_workspace_dirs(&default_space_root, &managed_root);
        }
    }

    for legacy_workspace_root in legacy_workspace_root_candidates(store, db_path.as_deref()) {
        if is_same_path(&legacy_workspace_root, &workspace_base) {
            continue;
        }
        let _ = migrate_legacy_workspace_dirs(&default_space_root, &legacy_workspace_root);

        let legacy_spaces_root = legacy_workspace_root.join("spaces");
        if !legacy_spaces_root.exists() {
            continue;
        }
        for entry in fs::read_dir(&legacy_spaces_root).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            if name.trim().is_empty() {
                continue;
            }
            let id = format!("legacy-{}", slug_from_relative_path(&name));
            if !store.spaces.iter().any(|space| space.id == id) {
                let timestamp = now_iso();
                store.spaces.push(SpaceRecord {
                    id: id.clone(),
                    name: name.clone(),
                    created_at: timestamp.clone(),
                    updated_at: timestamp,
                });
            }
            let target_root = workspace_base.join("spaces").join(&id);
            ensure_workspace_dirs(&target_root)?;
            let _ = migrate_legacy_workspace_dirs(&target_root, &path);
        }
    }

    for space in store.spaces.clone() {
        if space.id == "default" {
            continue;
        }
        let source = store_root.join("spaces").join(&space.id);
        let target = workspace_base.join("spaces").join(&space.id);
        if source.exists() {
            ensure_workspace_dirs(&target)?;
            let _ = migrate_legacy_workspace_dirs(&target, &source);
        }
    }

    store.legacy_imported_at = Some(now_iso());
    if let Some(db_path) = db_path {
        store.legacy_import_source = Some(db_path.display().to_string());
    }
    let _ = hydrate_store_from_workspace_files(store, store_path);
    Ok(())
}
