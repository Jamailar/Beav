use super::*;
use std::io::Write;

pub(super) fn session_transcript_path(
    state: &State<'_, AppState>,
    session_id: &str,
) -> Result<PathBuf, String> {
    let dir = session_transcript_dir(state)?;
    resolve_storage_file_path(&dir, session_id, "jsonl")
}

fn session_transcript_index_path(state: &State<'_, AppState>) -> Result<PathBuf, String> {
    Ok(session_transcript_dir(state)?.join("index.json"))
}

pub(super) fn append_transcript_entry(
    state: &State<'_, AppState>,
    session_id: &str,
    entry: &SessionTranscriptFileEntry,
) -> Result<(), String> {
    let path = session_transcript_path(state, session_id)?;
    let serialized = serde_json::to_string(entry).map_err(|error| error.to_string())?;
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|error| error.to_string())?;
    writeln!(file, "{serialized}").map_err(|error| error.to_string())
}

pub(super) fn replace_transcript_entries(
    state: &State<'_, AppState>,
    session_id: &str,
    entries: &[SessionTranscriptFileEntry],
) -> Result<(), String> {
    let path = session_transcript_path(state, session_id)?;
    let mut file = fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(path)
        .map_err(|error| error.to_string())?;
    for entry in entries {
        let serialized = serde_json::to_string(entry).map_err(|error| error.to_string())?;
        writeln!(file, "{serialized}").map_err(|error| error.to_string())?;
    }
    Ok(())
}

pub(crate) fn load_transcript_entries(
    state: &State<'_, AppState>,
    session_id: &str,
) -> Result<Vec<SessionTranscriptFileEntry>, String> {
    let path = session_transcript_path(state, session_id)?;
    let content = match fs::read_to_string(path) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.to_string()),
    };
    let mut entries = Vec::new();
    for line in content.lines().filter(|line| !line.trim().is_empty()) {
        if let Ok(entry) = serde_json::from_str::<SessionTranscriptFileEntry>(line) {
            entries.push(entry);
        }
    }
    Ok(entries)
}

pub(super) fn load_session_transcript_file_index(
    state: &State<'_, AppState>,
) -> Result<SessionTranscriptFileIndex, String> {
    let path = session_transcript_index_path(state)?;
    let content = match fs::read_to_string(path) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(SessionTranscriptFileIndex::default());
        }
        Err(error) => return Err(error.to_string()),
    };
    serde_json::from_str::<SessionTranscriptFileIndex>(&content).map_err(|error| error.to_string())
}

pub(super) fn persist_session_transcript_file_index(
    state: &State<'_, AppState>,
    index: &SessionTranscriptFileIndex,
) -> Result<(), String> {
    let path = session_transcript_index_path(state)?;
    let serialized = serde_json::to_string_pretty(index).map_err(|error| error.to_string())?;
    fs::write(path, serialized).map_err(|error| error.to_string())
}

pub(super) fn remove_session_transcript_meta(
    state: &State<'_, AppState>,
    session_id: &str,
) -> Result<(), String> {
    let mut index = load_session_transcript_file_index(state)?;
    let before = index.sessions.len();
    index.sessions.retain(|item| item.session_id != session_id);
    if index.sessions.len() != before {
        persist_session_transcript_file_index(state, &index)?;
    }
    Ok(())
}

pub(super) fn session_transcript_metadata_snapshot(
    state: &State<'_, AppState>,
    session_id: &str,
    runtime_mode: &str,
    protocol: &str,
    model_name: Option<&str>,
    message_count: i64,
    updated_at: &str,
    summary: &str,
) -> Result<SessionTranscriptFileMeta, String> {
    let (title, mode, tag, pr_number, pr_url, worktree_path) = with_store(state, |store| {
        let session = store
            .chat_sessions
            .iter()
            .find(|item| item.id == session_id);
        let metadata: Option<&Value> = session.and_then(|item| item.metadata.as_ref());
        Ok((
            session
                .map(|item| item.title.clone())
                .unwrap_or_else(|| "New Chat".to_string()),
            metadata
                .and_then(|value: &Value| value.get("mode"))
                .and_then(Value::as_str)
                .map(ToString::to_string),
            metadata
                .and_then(|value: &Value| value.get("tag"))
                .and_then(Value::as_str)
                .map(ToString::to_string),
            metadata
                .and_then(|value: &Value| value.get("prNumber"))
                .and_then(Value::as_i64),
            metadata
                .and_then(|value: &Value| value.get("prUrl"))
                .and_then(Value::as_str)
                .map(ToString::to_string),
            metadata
                .and_then(|value: &Value| value.get("worktreePath"))
                .and_then(Value::as_str)
                .map(ToString::to_string),
        ))
    })?;
    let git_branch = current_git_branch(state).ok();
    Ok(SessionTranscriptFileMeta {
        session_id: session_id.to_string(),
        created_at: updated_at.to_string(),
        updated_at: updated_at.to_string(),
        title,
        summary: summary.to_string(),
        protocol: protocol.to_string(),
        runtime_mode: runtime_mode.to_string(),
        mode,
        model_name: model_name.map(ToString::to_string),
        tag,
        git_branch,
        worktree_path,
        pr_number,
        pr_url,
        message_count,
        has_compaction: false,
    })
}

pub(super) fn update_session_transcript_index(
    state: &State<'_, AppState>,
    meta: SessionTranscriptFileMeta,
) -> Result<(), String> {
    let mut index = load_session_transcript_file_index(state)?;
    if let Some(existing) = index
        .sessions
        .iter_mut()
        .find(|item| item.session_id == meta.session_id)
    {
        let created_at = existing.created_at.clone();
        *existing = meta;
        existing.created_at = created_at;
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
    let removed = if overflow > 0 {
        index.sessions.drain(..overflow).collect::<Vec<_>>()
    } else {
        Vec::new()
    };
    persist_session_transcript_file_index(state, &index)?;
    for meta in removed {
        let _ = fs::remove_file(session_transcript_path(state, &meta.session_id)?);
    }
    Ok(())
}

fn current_git_branch(state: &State<'_, AppState>) -> Result<String, String> {
    let cwd = crate::workspace_root(state).unwrap_or_else(|_| PathBuf::from("."));
    let output = background_command("git")
        .arg("rev-parse")
        .arg("--abbrev-ref")
        .arg("HEAD")
        .current_dir(cwd)
        .output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}
