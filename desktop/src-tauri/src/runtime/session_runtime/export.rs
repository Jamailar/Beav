use super::*;
use crate::runtime::{RuntimeEventRecord, SessionToolResultRecord};
use crate::{ChatSessionRecord, SessionTranscriptRecord};
use std::collections::HashSet;
use std::io::{BufRead, Write};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct SessionExportManifest {
    pub export_id: String,
    pub session_id: String,
    pub exported_at: String,
    pub include_child_sessions: bool,
    pub child_session_ids: Vec<String>,
    pub title: String,
    pub protocol: Option<String>,
    pub runtime_mode: Option<String>,
    pub model_name: Option<String>,
    pub item_count: i64,
    pub message_count: i64,
    pub transcript_record_count: i64,
    pub transcript_file_entry_count: i64,
    pub checkpoint_count: i64,
    pub tool_result_count: i64,
    pub runtime_event_count: i64,
    pub bundle_message_count: i64,
    pub files: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct SessionCanonicalItem {
    pub item_id: String,
    pub session_id: String,
    pub turn_id: Option<String>,
    pub kind: String,
    pub created_at: Value,
    pub payload: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct SessionExportBundle {
    pub manifest: SessionExportManifest,
    pub sessions: Vec<ChatSessionRecord>,
    pub messages: Vec<ChatMessageRecord>,
    pub transcript_records: Vec<SessionTranscriptRecord>,
    pub transcript_file_entries: Vec<SessionTranscriptFileEntry>,
    pub checkpoints: Vec<SessionCheckpointRecord>,
    pub tool_results: Vec<SessionToolResultRecord>,
    pub runtime_events: Vec<RuntimeEventRecord>,
    pub bundle_messages: Vec<Value>,
    pub canonical_items: Vec<SessionCanonicalItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct SessionImportOutcome {
    pub session_id: String,
    pub imported_session_ids: Vec<String>,
    pub message_count: i64,
    pub transcript_record_count: i64,
    pub transcript_file_entry_count: i64,
    pub checkpoint_count: i64,
    pub tool_result_count: i64,
    pub runtime_event_count: i64,
    pub bundle_message_count: i64,
    pub overwritten: bool,
}

fn canonical_item(
    item_id: impl Into<String>,
    session_id: impl Into<String>,
    turn_id: Option<String>,
    kind: &str,
    created_at: Value,
    payload: Value,
) -> SessionCanonicalItem {
    SessionCanonicalItem {
        item_id: item_id.into(),
        session_id: session_id.into(),
        turn_id,
        kind: kind.to_string(),
        created_at,
        payload,
    }
}

fn value_turn_id(value: Option<&Value>) -> Option<String> {
    let value = value?;
    value
        .get("turnId")
        .or_else(|| value.get("turn_id"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .map(ToString::to_string)
}

fn metadata_turn_id(metadata: Option<&Value>) -> Option<String> {
    value_turn_id(metadata).or_else(|| {
        metadata
            .and_then(|value| value.get("runtime"))
            .and_then(|value| value_turn_id(Some(value)))
    })
}

fn transcript_entry_session_id(entry: &SessionTranscriptFileEntry) -> &str {
    match entry {
        SessionTranscriptFileEntry::Message { session_id, .. }
        | SessionTranscriptFileEntry::Metadata { session_id, .. }
        | SessionTranscriptFileEntry::CompactBoundary { session_id, .. } => session_id,
    }
}

fn transcript_entry_id(entry: &SessionTranscriptFileEntry) -> &str {
    match entry {
        SessionTranscriptFileEntry::Message { entry_id, .. }
        | SessionTranscriptFileEntry::Metadata { entry_id, .. }
        | SessionTranscriptFileEntry::CompactBoundary { entry_id, .. } => entry_id,
    }
}

fn transcript_entry_created_at(entry: &SessionTranscriptFileEntry) -> &str {
    match entry {
        SessionTranscriptFileEntry::Message { created_at, .. }
        | SessionTranscriptFileEntry::Metadata { created_at, .. }
        | SessionTranscriptFileEntry::CompactBoundary { created_at, .. } => created_at,
    }
}

pub fn canonical_item_for_transcript_record(
    record: &SessionTranscriptRecord,
) -> SessionCanonicalItem {
    let mut payload = serde_json::to_value(record).unwrap_or_else(|_| json!({}));
    if let Some(record_payload) = payload.get_mut("payload").and_then(Value::as_object_mut) {
        record_payload.remove("canonicalItem");
    }
    canonical_item(
        record.id.clone(),
        record.session_id.clone(),
        value_turn_id(record.payload.as_ref()),
        "transcript_record",
        json!(record.created_at),
        payload,
    )
}

fn canonical_items_for_export(bundle: &SessionExportBundle) -> Vec<SessionCanonicalItem> {
    let mut items = Vec::new();
    for session in &bundle.sessions {
        items.push(canonical_item(
            format!("session-meta:{}", session.id),
            session.id.clone(),
            None,
            "session_meta",
            json!(session.created_at),
            json!(session),
        ));
    }
    for message in &bundle.messages {
        items.push(canonical_item(
            message.id.clone(),
            message.session_id.clone(),
            metadata_turn_id(message.metadata.as_ref()),
            "message",
            json!(message.created_at),
            json!(message),
        ));
    }
    for record in &bundle.transcript_records {
        items.push(canonical_item_for_transcript_record(record));
    }
    for entry in &bundle.transcript_file_entries {
        let payload = serde_json::to_value(entry).unwrap_or_else(|_| json!({}));
        items.push(canonical_item(
            transcript_entry_id(entry).to_string(),
            transcript_entry_session_id(entry).to_string(),
            match entry {
                SessionTranscriptFileEntry::Message { message, .. } => value_turn_id(Some(message)),
                _ => None,
            },
            "transcript_file_entry",
            json!(transcript_entry_created_at(entry)),
            payload,
        ));
    }
    for checkpoint in &bundle.checkpoints {
        items.push(canonical_item(
            checkpoint.id.clone(),
            checkpoint.session_id.clone(),
            value_turn_id(checkpoint.payload.as_ref()),
            "checkpoint",
            json!(checkpoint.created_at),
            json!(checkpoint),
        ));
    }
    for result in &bundle.tool_results {
        items.push(canonical_item(
            result.id.clone(),
            result.session_id.clone(),
            value_turn_id(result.payload.as_ref()),
            "tool_result",
            json!(result.created_at),
            json!(result),
        ));
    }
    for event in &bundle.runtime_events {
        items.push(canonical_item(
            event.id.clone(),
            event.session_id.clone().unwrap_or_default(),
            value_turn_id(event.payload.as_ref()),
            "runtime_event",
            json!(event.created_at),
            json!(event),
        ));
    }
    for (index, message) in bundle.bundle_messages.iter().enumerate() {
        items.push(canonical_item(
            format!("bundle-message:{}:{index}", bundle.manifest.session_id),
            bundle.manifest.session_id.clone(),
            value_turn_id(Some(message)),
            "bundle_message",
            json!(bundle.manifest.exported_at),
            message.clone(),
        ));
    }
    items
}

fn session_ids_for_export(
    store: &AppStore,
    session_id: &str,
    include_child_sessions: bool,
) -> Vec<String> {
    let mut ids = session_ids_for_query(store, session_id, include_child_sessions);
    ids.sort();
    ids.dedup();
    ids
}

pub fn build_session_export_bundle(
    store: &AppStore,
    session_id: &str,
    include_child_sessions: bool,
    transcript_file_entries: Vec<SessionTranscriptFileEntry>,
    bundle_messages: Vec<Value>,
) -> Option<SessionExportBundle> {
    let root_session = store
        .chat_sessions
        .iter()
        .find(|item| item.id == session_id)
        .cloned()?;
    let session_ids = session_ids_for_export(store, session_id, include_child_sessions);
    let mut sessions = store
        .chat_sessions
        .iter()
        .filter(|item| session_ids.iter().any(|session_id| session_id == &item.id))
        .cloned()
        .collect::<Vec<_>>();
    sessions.sort_by(|a, b| compare_created_at(&a.created_at, &b.created_at));

    let mut messages = store
        .chat_messages
        .iter()
        .filter(|item| {
            session_ids
                .iter()
                .any(|session_id| session_id == &item.session_id)
        })
        .cloned()
        .collect::<Vec<_>>();
    messages.sort_by(|a, b| compare_created_at(&a.created_at, &b.created_at));

    let mut transcript_records = store
        .session_transcript_records
        .iter()
        .filter(|item| {
            session_ids
                .iter()
                .any(|session_id| session_id == &item.session_id)
        })
        .cloned()
        .collect::<Vec<_>>();
    transcript_records.sort_by_key(|item| item.created_at);

    let mut checkpoints = store
        .session_checkpoints
        .iter()
        .filter(|item| {
            session_ids
                .iter()
                .any(|session_id| session_id == &item.session_id)
        })
        .cloned()
        .collect::<Vec<_>>();
    checkpoints.sort_by_key(|item| item.created_at);

    let mut tool_results = store
        .session_tool_results
        .iter()
        .filter(|item| {
            session_ids
                .iter()
                .any(|session_id| session_id == &item.session_id)
        })
        .cloned()
        .collect::<Vec<_>>();
    tool_results.sort_by_key(|item| item.created_at);

    let mut runtime_events = store
        .runtime_events
        .iter()
        .filter(|item| {
            item.session_id
                .as_ref()
                .map(|value| session_ids.iter().any(|session_id| session_id == value))
                .unwrap_or(false)
        })
        .cloned()
        .collect::<Vec<_>>();
    runtime_events.sort_by_key(|item| item.created_at);

    let child_session_ids = session_ids
        .iter()
        .filter(|item| item.as_str() != session_id)
        .cloned()
        .collect::<Vec<_>>();
    let mut bundle = SessionExportBundle {
        manifest: SessionExportManifest {
            export_id: make_id("session-export"),
            session_id: session_id.to_string(),
            exported_at: now_iso(),
            include_child_sessions,
            child_session_ids,
            title: root_session.title,
            protocol: Some("redconvert-session-export/v1".to_string()),
            runtime_mode: root_session
                .metadata
                .as_ref()
                .and_then(|metadata| metadata.get("runtimeMode").or_else(|| metadata.get("mode")))
                .and_then(Value::as_str)
                .map(ToString::to_string),
            model_name: None,
            item_count: 0,
            message_count: messages.len() as i64,
            transcript_record_count: transcript_records.len() as i64,
            transcript_file_entry_count: transcript_file_entries.len() as i64,
            checkpoint_count: checkpoints.len() as i64,
            tool_result_count: tool_results.len() as i64,
            runtime_event_count: runtime_events.len() as i64,
            bundle_message_count: bundle_messages.len() as i64,
            files: vec![
                "manifest.json".to_string(),
                "sessions.jsonl".to_string(),
                "session-items.jsonl".to_string(),
                "messages.json".to_string(),
                "transcript-records.jsonl".to_string(),
                "transcript-file-entries.jsonl".to_string(),
                "checkpoints.jsonl".to_string(),
                "tool-results.jsonl".to_string(),
                "runtime-events.jsonl".to_string(),
                "bundle-messages.json".to_string(),
            ],
        },
        sessions,
        messages,
        transcript_records,
        transcript_file_entries,
        checkpoints,
        tool_results,
        runtime_events,
        bundle_messages,
        canonical_items: Vec::new(),
    };
    bundle.canonical_items = canonical_items_for_export(&bundle);
    bundle.manifest.item_count = bundle.canonical_items.len() as i64;
    Some(bundle)
}

pub fn session_export_bundle_value(bundle: &SessionExportBundle) -> Value {
    json!({
        "success": true,
        "manifest": bundle.manifest,
        "sessions": bundle.sessions,
        "messages": bundle.messages,
        "transcriptRecords": bundle.transcript_records,
        "transcriptFileEntries": bundle.transcript_file_entries,
        "checkpoints": bundle.checkpoints,
        "toolResults": bundle.tool_results,
        "runtimeEvents": bundle.runtime_events,
        "bundleMessages": bundle.bundle_messages,
        "sessionItems": bundle.canonical_items,
    })
}

fn write_json(path: &Path, value: &impl Serialize) -> Result<(), String> {
    let serialized = serde_json::to_string_pretty(value).map_err(|error| error.to_string())?;
    fs::write(path, serialized).map_err(|error| error.to_string())
}

fn write_jsonl<T: Serialize>(path: &Path, items: &[T]) -> Result<(), String> {
    let mut file = fs::File::create(path).map_err(|error| error.to_string())?;
    for item in items {
        let serialized = serde_json::to_string(item).map_err(|error| error.to_string())?;
        writeln!(file, "{serialized}").map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<T, String> {
    let content = fs::read_to_string(path).map_err(|error| error.to_string())?;
    serde_json::from_str(&content).map_err(|error| error.to_string())
}

fn read_json_or_default<T: for<'de> Deserialize<'de> + Default>(path: &Path) -> Result<T, String> {
    if !path.exists() {
        return Ok(T::default());
    }
    read_json(path)
}

fn read_jsonl<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<Vec<T>, String> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let file = fs::File::open(path).map_err(|error| error.to_string())?;
    let reader = std::io::BufReader::new(file);
    let mut items = Vec::new();
    for line in reader.lines() {
        let line = line.map_err(|error| error.to_string())?;
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        items.push(serde_json::from_str::<T>(trimmed).map_err(|error| error.to_string())?);
    }
    Ok(items)
}

pub fn read_session_export_package(package_path: &Path) -> Result<SessionExportBundle, String> {
    if !package_path.is_dir() {
        return Err("session export package path is not a directory".to_string());
    }
    let manifest: SessionExportManifest = read_json(&package_path.join("manifest.json"))?;
    let mut sessions: Vec<ChatSessionRecord> = read_jsonl(&package_path.join("sessions.jsonl"))
        .or_else(|_| read_json_or_default(&package_path.join("sessions.json")))?;
    if sessions.is_empty() && !manifest.session_id.trim().is_empty() {
        sessions.push(ChatSessionRecord {
            id: manifest.session_id.clone(),
            title: if manifest.title.trim().is_empty() {
                "Imported Session".to_string()
            } else {
                manifest.title.clone()
            },
            created_at: manifest.exported_at.clone(),
            updated_at: manifest.exported_at.clone(),
            metadata: Some(json!({
                "contextType": "chat",
                "runtimeMode": manifest.runtime_mode,
                "importedFromExportId": manifest.export_id,
            })),
            deleted_at: None,
            starred: false,
            archived: false,
            archived_at: None,
        });
    }
    let messages: Vec<ChatMessageRecord> =
        read_json_or_default(&package_path.join("messages.json"))?;
    let transcript_records: Vec<SessionTranscriptRecord> =
        read_jsonl(&package_path.join("transcript-records.jsonl"))?;
    let transcript_file_entries: Vec<SessionTranscriptFileEntry> =
        read_jsonl(&package_path.join("transcript-file-entries.jsonl"))?;
    let checkpoints: Vec<SessionCheckpointRecord> =
        read_jsonl(&package_path.join("checkpoints.jsonl"))?;
    let tool_results: Vec<SessionToolResultRecord> =
        read_jsonl(&package_path.join("tool-results.jsonl"))?;
    let runtime_events: Vec<RuntimeEventRecord> =
        read_jsonl(&package_path.join("runtime-events.jsonl"))?;
    let bundle_messages: Vec<Value> =
        read_json_or_default(&package_path.join("bundle-messages.json"))?;
    let canonical_items: Vec<SessionCanonicalItem> =
        read_jsonl(&package_path.join("session-items.jsonl"))?;

    Ok(SessionExportBundle {
        manifest,
        sessions,
        messages,
        transcript_records,
        transcript_file_entries,
        checkpoints,
        tool_results,
        runtime_events,
        bundle_messages,
        canonical_items,
    })
}

fn retain_not_in_session_ids<T>(
    items: &mut Vec<T>,
    session_ids: &HashSet<String>,
    session_id: impl Fn(&T) -> Option<&str>,
) {
    items.retain(|item| {
        session_id(item)
            .map(|value| !session_ids.contains(value))
            .unwrap_or(true)
    });
}

fn dedupe_by_id<T>(items: Vec<T>, id: impl Fn(&T) -> &str) -> Vec<T> {
    let mut seen = HashSet::new();
    items
        .into_iter()
        .filter(|item| seen.insert(id(item).to_string()))
        .collect()
}

pub fn apply_session_export_bundle_to_store(
    store: &mut AppStore,
    bundle: &SessionExportBundle,
    overwrite: bool,
) -> Result<SessionImportOutcome, String> {
    if bundle.manifest.session_id.trim().is_empty() {
        return Err("export manifest is missing sessionId".to_string());
    }
    let mut session_ids = bundle
        .sessions
        .iter()
        .map(|item| item.id.clone())
        .collect::<HashSet<_>>();
    session_ids.insert(bundle.manifest.session_id.clone());
    for id in &bundle.manifest.child_session_ids {
        session_ids.insert(id.clone());
    }

    let existing = store
        .chat_sessions
        .iter()
        .filter(|item| session_ids.contains(&item.id))
        .map(|item| item.id.clone())
        .collect::<Vec<_>>();
    if !overwrite && !existing.is_empty() {
        return Err(format!(
            "session already exists: {}",
            existing.first().cloned().unwrap_or_default()
        ));
    }

    if overwrite {
        store
            .chat_sessions
            .retain(|item| !session_ids.contains(&item.id));
        retain_not_in_session_ids(&mut store.chat_messages, &session_ids, |item| {
            Some(item.session_id.as_str())
        });
        retain_not_in_session_ids(&mut store.session_context_records, &session_ids, |item| {
            Some(item.session_id.as_str())
        });
        retain_not_in_session_ids(
            &mut store.session_transcript_records,
            &session_ids,
            |item| Some(item.session_id.as_str()),
        );
        retain_not_in_session_ids(&mut store.session_checkpoints, &session_ids, |item| {
            Some(item.session_id.as_str())
        });
        retain_not_in_session_ids(&mut store.session_tool_results, &session_ids, |item| {
            Some(item.session_id.as_str())
        });
        retain_not_in_session_ids(&mut store.runtime_events, &session_ids, |item| {
            item.session_id.as_deref()
        });
    }

    let imported_session_ids = bundle
        .sessions
        .iter()
        .map(|item| item.id.clone())
        .collect::<Vec<_>>();
    store
        .chat_sessions
        .extend(dedupe_by_id(bundle.sessions.clone(), |item| {
            item.id.as_str()
        }));
    store
        .chat_messages
        .extend(dedupe_by_id(bundle.messages.clone(), |item| {
            item.id.as_str()
        }));
    store
        .session_transcript_records
        .extend(dedupe_by_id(bundle.transcript_records.clone(), |item| {
            item.id.as_str()
        }));
    store
        .session_checkpoints
        .extend(dedupe_by_id(bundle.checkpoints.clone(), |item| {
            item.id.as_str()
        }));
    store
        .session_tool_results
        .extend(dedupe_by_id(bundle.tool_results.clone(), |item| {
            item.id.as_str()
        }));
    store
        .runtime_events
        .extend(dedupe_by_id(bundle.runtime_events.clone(), |item| {
            item.id.as_str()
        }));

    Ok(SessionImportOutcome {
        session_id: bundle.manifest.session_id.clone(),
        imported_session_ids,
        message_count: bundle.messages.len() as i64,
        transcript_record_count: bundle.transcript_records.len() as i64,
        transcript_file_entry_count: bundle.transcript_file_entries.len() as i64,
        checkpoint_count: bundle.checkpoints.len() as i64,
        tool_result_count: bundle.tool_results.len() as i64,
        runtime_event_count: bundle.runtime_events.len() as i64,
        bundle_message_count: bundle.bundle_messages.len() as i64,
        overwritten: overwrite,
    })
}

fn remove_transcript_file_for_session(
    state: &State<'_, AppState>,
    session_id: &str,
) -> Result<(), String> {
    match fs::remove_file(session_transcript_path(state, session_id)?) {
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

pub fn persist_imported_session_export_files(
    state: &State<'_, AppState>,
    bundle: &SessionExportBundle,
    overwrite: bool,
) -> Result<(), String> {
    let mut session_ids = bundle
        .sessions
        .iter()
        .map(|item| item.id.clone())
        .collect::<HashSet<_>>();
    session_ids.insert(bundle.manifest.session_id.clone());
    for id in &bundle.manifest.child_session_ids {
        session_ids.insert(id.clone());
    }
    if overwrite {
        for id in &session_ids {
            let _ = remove_session_bundle(state, id);
            let _ = remove_transcript_file_for_session(state, id);
            let _ = remove_session_transcript_meta(state, id);
        }
    }
    for entry in &bundle.transcript_file_entries {
        append_transcript_entry(state, transcript_entry_session_id(entry), entry)?;
    }
    if !bundle.bundle_messages.is_empty() {
        save_session_bundle_messages(
            state,
            &bundle.manifest.session_id,
            bundle
                .manifest
                .protocol
                .as_deref()
                .unwrap_or("redconvert-session-export/v1"),
            bundle.manifest.runtime_mode.as_deref().unwrap_or("default"),
            bundle.manifest.model_name.as_deref(),
            &bundle.bundle_messages,
        )?;
    }
    Ok(())
}

pub fn write_session_export_package(
    state: &State<'_, AppState>,
    bundle: &SessionExportBundle,
) -> Result<Value, String> {
    let export_root = store_root(state)?.join("session-exports");
    fs::create_dir_all(&export_root).map_err(|error| error.to_string())?;
    let package_dir = export_root.join(storage_safe_file_stem(&format!(
        "{}-{}",
        bundle.manifest.session_id, bundle.manifest.export_id
    )));
    fs::create_dir_all(&package_dir).map_err(|error| error.to_string())?;

    write_json(&package_dir.join("manifest.json"), &bundle.manifest)?;
    write_jsonl(&package_dir.join("sessions.jsonl"), &bundle.sessions)?;
    write_jsonl(
        &package_dir.join("session-items.jsonl"),
        &bundle.canonical_items,
    )?;
    write_json(&package_dir.join("messages.json"), &bundle.messages)?;
    write_jsonl(
        &package_dir.join("transcript-records.jsonl"),
        &bundle.transcript_records,
    )?;
    write_jsonl(
        &package_dir.join("transcript-file-entries.jsonl"),
        &bundle.transcript_file_entries,
    )?;
    write_jsonl(&package_dir.join("checkpoints.jsonl"), &bundle.checkpoints)?;
    write_jsonl(
        &package_dir.join("tool-results.jsonl"),
        &bundle.tool_results,
    )?;
    write_jsonl(
        &package_dir.join("runtime-events.jsonl"),
        &bundle.runtime_events,
    )?;
    write_json(
        &package_dir.join("bundle-messages.json"),
        &bundle.bundle_messages,
    )?;

    Ok(json!({
        "success": true,
        "exportId": bundle.manifest.export_id,
        "sessionId": bundle.manifest.session_id,
        "packagePath": package_dir.to_string_lossy(),
        "manifest": bundle.manifest,
    }))
}
