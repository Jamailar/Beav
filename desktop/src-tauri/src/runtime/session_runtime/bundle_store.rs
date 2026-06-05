use super::*;

pub(super) fn session_runtime_bundle_dir(state: &State<'_, AppState>) -> Result<PathBuf, String> {
    let dir = store_root(state)?.join("session-bundles");
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    Ok(dir)
}

pub(super) fn session_runtime_bundle_path(
    state: &State<'_, AppState>,
    session_id: &str,
) -> Result<PathBuf, String> {
    let dir = session_runtime_bundle_dir(state)?;
    resolve_storage_file_path(&dir, session_id, "json")
}

fn session_runtime_bundle_index_path(state: &State<'_, AppState>) -> Result<PathBuf, String> {
    Ok(session_runtime_bundle_dir(state)?.join("index.json"))
}

fn load_session_runtime_bundle_index(
    state: &State<'_, AppState>,
) -> Result<SessionRuntimeBundleIndex, String> {
    let path = session_runtime_bundle_index_path(state)?;
    let content = match fs::read_to_string(path) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(SessionRuntimeBundleIndex::default());
        }
        Err(error) => return Err(error.to_string()),
    };
    match serde_json::from_str::<SessionRuntimeBundleIndex>(&content) {
        Ok(index) => Ok(index),
        Err(_error) => {
            let dir = session_runtime_bundle_dir(state)?;
            quarantine_corrupt_json_file(&session_runtime_bundle_index_path(state)?)?;
            Ok(rebuild_session_runtime_bundle_index_from_dir(&dir))
        }
    }
}

fn persist_session_runtime_bundle_index(
    state: &State<'_, AppState>,
    index: &SessionRuntimeBundleIndex,
) -> Result<(), String> {
    let path = session_runtime_bundle_index_path(state)?;
    let serialized = serde_json::to_string_pretty(index).map_err(|error| error.to_string())?;
    fs::write(path, serialized).map_err(|error| error.to_string())
}

fn quarantine_corrupt_json_file(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("index.json");
    let backup_path = path.with_file_name(format!("{file_name}.corrupt-{timestamp}"));
    fs::rename(path, backup_path).map_err(|error| error.to_string())
}

pub(super) fn rebuild_session_runtime_bundle_index_from_dir(
    dir: &Path,
) -> SessionRuntimeBundleIndex {
    let mut index = SessionRuntimeBundleIndex::default();
    let Ok(entries) = fs::read_dir(dir) else {
        return index;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.file_name().and_then(|value| value.to_str()) == Some("index.json") {
            continue;
        }
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let Ok(content) = fs::read_to_string(&path) else {
            continue;
        };
        let Ok(bundle) = serde_json::from_str::<SessionRuntimeBundle>(&content) else {
            continue;
        };
        let _removed = update_session_bundle_index(&mut index, &bundle);
    }
    index
}

pub(super) fn update_session_bundle_index(
    index: &mut SessionRuntimeBundleIndex,
    bundle: &SessionRuntimeBundle,
) -> Vec<String> {
    let meta = SessionRuntimeBundleMeta {
        session_id: bundle.session_id.clone(),
        created_at: bundle.created_at.clone(),
        updated_at: bundle.updated_at.clone(),
        protocol: bundle.protocol.clone(),
        runtime_mode: bundle.runtime_mode.clone(),
        model_name: bundle.model_name.clone(),
        summary: session_bundle_summary_from_messages(&bundle.messages),
        message_count: bundle.message_count,
    };
    if let Some(existing) = index
        .sessions
        .iter_mut()
        .find(|item| item.session_id == bundle.session_id)
    {
        *existing = meta;
    } else {
        index.sessions.push(meta);
    }
    index
        .sessions
        .sort_by(|a, b| compare_iso_or_numeric(&a.updated_at, &b.updated_at));
    let overflow = index
        .sessions
        .len()
        .saturating_sub(SESSION_BUNDLE_MAX_SESSIONS);
    if overflow == 0 {
        return Vec::new();
    }
    index
        .sessions
        .drain(..overflow)
        .map(|item| item.session_id)
        .collect::<Vec<_>>()
}

pub(super) fn remove_session_bundle_meta(
    state: &State<'_, AppState>,
    session_id: &str,
) -> Result<(), String> {
    let mut index = load_session_runtime_bundle_index(state)?;
    let before = index.sessions.len();
    index.sessions.retain(|item| item.session_id != session_id);
    if index.sessions.len() != before {
        persist_session_runtime_bundle_index(state, &index)?;
    }
    Ok(())
}

pub(super) fn resolve_session_id_or_latest(
    state: &State<'_, AppState>,
    session_id: &str,
) -> Result<String, String> {
    let normalized = session_id.trim();
    if normalized != "latest" {
        return Ok(normalized.to_string());
    }
    let index = load_session_runtime_bundle_index(state)?;
    index
        .sessions
        .last()
        .map(|item| item.session_id.clone())
        .ok_or_else(|| "No session bundles found".to_string())
}

pub(super) fn load_session_runtime_bundle(
    state: &State<'_, AppState>,
    session_id: &str,
) -> Result<Option<SessionRuntimeBundle>, String> {
    let path = session_runtime_bundle_path(state, session_id)?;
    let content = match fs::read_to_string(path) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    let bundle = serde_json::from_str::<SessionRuntimeBundle>(&content)
        .map_err(|error| error.to_string())?;
    Ok(Some(bundle))
}

pub(super) fn persist_session_runtime_bundle(
    state: &State<'_, AppState>,
    bundle: &SessionRuntimeBundle,
) -> Result<(), String> {
    let path = session_runtime_bundle_path(state, &bundle.session_id)?;
    let serialized = serde_json::to_string_pretty(bundle).map_err(|error| error.to_string())?;
    fs::write(&path, serialized).map_err(|error| error.to_string())?;

    let mut index = load_session_runtime_bundle_index(state)?;
    let removed_ids = update_session_bundle_index(&mut index, bundle);
    persist_session_runtime_bundle_index(state, &index)?;
    for removed_id in removed_ids {
        let removed_path = session_runtime_bundle_path(state, &removed_id)?;
        let _ = fs::remove_file(removed_path);
        let legacy_removed_path =
            legacy_storage_file_path(&session_runtime_bundle_dir(state)?, &removed_id, "json");
        let _ = fs::remove_file(legacy_removed_path);
    }
    Ok(())
}
