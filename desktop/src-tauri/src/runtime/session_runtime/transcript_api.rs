use super::*;

pub fn list_transcript_sessions(
    state: &State<'_, AppState>,
) -> Result<Vec<SessionTranscriptFileMeta>, String> {
    let mut items = load_session_transcript_file_index(state)?.sessions;
    items.sort_by(|a, b| compare_iso_or_numeric(&b.updated_at, &a.updated_at));
    Ok(items)
}

pub fn transcript_session_meta_value(meta: &SessionTranscriptFileMeta) -> Value {
    json!({
        "id": meta.session_id,
        "messageCount": meta.message_count,
        "summary": meta.summary,
        "title": meta.title,
        "tag": meta.tag,
        "gitBranch": meta.git_branch,
        "worktreePath": meta.worktree_path,
        "prNumber": meta.pr_number,
        "prUrl": meta.pr_url,
        "protocol": meta.protocol,
        "runtimeMode": meta.runtime_mode,
        "mode": meta.mode,
        "hasCompaction": meta.has_compaction,
        "chatSession": {
            "id": meta.session_id,
            "title": if meta.title.trim().is_empty() { "New Chat" } else { meta.title.as_str() },
            "updatedAt": meta.updated_at,
            "createdAt": meta.created_at,
        }
    })
}

pub fn transcript_session_meta_by_id(
    state: &State<'_, AppState>,
    session_id: &str,
) -> Result<Option<SessionTranscriptFileMeta>, String> {
    let resolved =
        resolve_session_id_or_latest(state, session_id).unwrap_or_else(|_| session_id.to_string());
    Ok(load_session_transcript_file_index(state)?
        .sessions
        .into_iter()
        .find(|item| item.session_id == resolved))
}

pub fn transcript_resume_messages(
    state: &State<'_, AppState>,
    store: &AppStore,
    session_id: &str,
    limit: usize,
) -> Result<Vec<Value>, String> {
    let entries =
        load_transcript_entries(state, &resolve_session_id_or_latest(state, session_id)?)?;
    if entries.is_empty() {
        return Ok(runtime_context_messages_for_session(
            None, store, session_id, limit,
        ));
    }
    let (messages, summary_prompt, _) = rebuild_messages_after_last_compaction(&entries);
    Ok(bundle_messages_for_runtime(
        &messages,
        summary_prompt,
        limit,
    ))
}

pub fn load_session_bundle_messages(
    state: &State<'_, AppState>,
    session_id: &str,
) -> Result<Vec<Value>, String> {
    Ok(
        load_session_runtime_bundle(state, &resolve_session_id_or_latest(state, session_id)?)?
            .map(|bundle| bundle.messages)
            .unwrap_or_default(),
    )
}

fn display_content_from_bundle_message(content: &str) -> String {
    const ACP_EXTERNAL_PROMPT_MARKER: &str = "\nExternal prompt:\n";
    if !content.starts_with("External agent request through RedBox ACP.") {
        return content.to_string();
    }
    content
        .split_once(ACP_EXTERNAL_PROMPT_MARKER)
        .map(|(_, prompt)| prompt.trim().to_string())
        .filter(|prompt| !prompt.is_empty())
        .unwrap_or_else(|| content.to_string())
}

pub fn load_session_bundle_chat_messages(
    state: &State<'_, AppState>,
    session_id: &str,
) -> Result<Vec<ChatMessageRecord>, String> {
    let resolved_session_id =
        resolve_session_id_or_latest(state, session_id).unwrap_or_else(|_| session_id.to_string());
    let messages = load_session_bundle_messages(state, &resolved_session_id)?;
    let mut restored = Vec::<ChatMessageRecord>::new();
    for (index, item) in messages.into_iter().enumerate() {
        if is_internal_runtime_bundle_message(&item) {
            continue;
        }
        let role = item
            .get("role")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|role| *role == "user" || *role == "assistant")
            .unwrap_or("");
        if role.is_empty() {
            continue;
        }
        let raw_content = item
            .get("content")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let content = display_content_from_bundle_message(&raw_content);
        if content.trim().is_empty() {
            continue;
        }
        if let Some(previous) = restored.last() {
            if previous.role == role && previous.content == content {
                continue;
            }
        }
        restored.push(ChatMessageRecord {
            id: format!("bundle-{resolved_session_id}-{index}"),
            session_id: resolved_session_id.clone(),
            role: role.to_string(),
            content,
            display_content: None,
            attachment: None,
            metadata: item.get("metadata").cloned(),
            created_at: format!("{index:013}"),
        });
    }
    Ok(restored)
}

pub fn merge_chat_messages_with_bundle_history(
    mut messages: Vec<ChatMessageRecord>,
    bundle_messages: Vec<ChatMessageRecord>,
) -> Vec<ChatMessageRecord> {
    messages.retain(|message| {
        !(message.role == "user" && is_internal_runtime_history_user_message(&message.content))
    });
    if bundle_messages.len() <= messages.len() {
        messages.sort_by(|a, b| compare_created_at(&a.created_at, &b.created_at));
        return messages;
    }
    let mut seen = bundle_messages
        .iter()
        .map(|message| (message.role.clone(), message.content.clone()))
        .collect::<std::collections::HashSet<_>>();
    let mut merged = bundle_messages;
    messages.sort_by(|a, b| compare_created_at(&a.created_at, &b.created_at));
    for message in messages {
        if seen.insert((message.role.clone(), message.content.clone())) {
            merged.push(message);
        }
    }
    merged.sort_by(|a, b| compare_created_at(&a.created_at, &b.created_at));
    merged
}

pub fn save_session_bundle_messages(
    state: &State<'_, AppState>,
    session_id: &str,
    protocol: &str,
    runtime_mode: &str,
    model_name: Option<&str>,
    messages: &[Value],
) -> Result<(), String> {
    let resolved_session_id =
        resolve_session_id_or_latest(state, session_id).unwrap_or_else(|_| session_id.to_string());
    let existing = load_session_runtime_bundle(state, &resolved_session_id)?;
    let bundle = SessionRuntimeBundle {
        session_id: resolved_session_id,
        created_at: existing
            .as_ref()
            .map(|item| item.created_at.clone())
            .filter(|item| !item.trim().is_empty())
            .unwrap_or_else(now_iso),
        protocol: protocol.to_string(),
        runtime_mode: runtime_mode.to_string(),
        model_name: model_name.map(ToString::to_string),
        message_count: messages.len() as i64,
        updated_at: now_iso(),
        messages: messages.to_vec(),
    };
    persist_session_runtime_bundle(state, &bundle)?;
    sync_transcript_from_bundle(state, &bundle)
}

pub fn remove_session_bundle(state: &State<'_, AppState>, session_id: &str) -> Result<(), String> {
    let resolved_session_id =
        resolve_session_id_or_latest(state, session_id).unwrap_or_else(|_| session_id.to_string());
    let path = session_runtime_bundle_path(state, &resolved_session_id)?;
    let transcript_path = session_transcript_path(state, &resolved_session_id)?;
    match fs::remove_file(path) {
        Ok(_) => {
            remove_session_bundle_meta(state, &resolved_session_id)?;
            let _ = fs::remove_file(transcript_path);
            let _ = remove_session_transcript_meta(state, &resolved_session_id);
            Ok(())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            remove_session_bundle_meta(state, &resolved_session_id)?;
            let _ = fs::remove_file(transcript_path);
            let _ = remove_session_transcript_meta(state, &resolved_session_id);
            Ok(())
        }
        Err(error) => Err(error.to_string()),
    }
}

pub fn duplicate_session_bundle(
    state: &State<'_, AppState>,
    source_session_id: &str,
    target_session_id: &str,
) -> Result<(), String> {
    let Some(mut bundle) = load_session_runtime_bundle(state, source_session_id)? else {
        return Ok(());
    };
    bundle.session_id = target_session_id.to_string();
    bundle.created_at = now_iso();
    bundle.updated_at = now_iso();
    bundle
        .messages
        .retain(|message| !is_internal_runtime_bundle_message(message));
    bundle.message_count = bundle.messages.len() as i64;
    persist_session_runtime_bundle(state, &bundle)?;
    let entries = load_transcript_entries(state, source_session_id)?;
    for entry in entries {
        let duplicated = match entry {
            SessionTranscriptFileEntry::Message {
                message,
                created_at,
                ..
            } => {
                if is_internal_runtime_bundle_message(&message) {
                    continue;
                }
                SessionTranscriptFileEntry::Message {
                    entry_id: make_id("entry"),
                    session_id: target_session_id.to_string(),
                    message,
                    created_at,
                }
            }
            SessionTranscriptFileEntry::Metadata {
                title,
                tag,
                git_branch,
                worktree_path,
                pr_number,
                pr_url,
                mode,
                runtime_mode,
                protocol,
                model_name,
                created_at,
                ..
            } => SessionTranscriptFileEntry::Metadata {
                entry_id: make_id("entry"),
                session_id: target_session_id.to_string(),
                title,
                tag,
                git_branch,
                worktree_path,
                pr_number,
                pr_url,
                mode,
                runtime_mode,
                protocol,
                model_name,
                created_at,
            },
            SessionTranscriptFileEntry::CompactBoundary {
                summary,
                preserved_entry_ids: _,
                preserved_message_count,
                created_at,
                ..
            } => SessionTranscriptFileEntry::CompactBoundary {
                entry_id: make_id("entry"),
                session_id: target_session_id.to_string(),
                summary,
                preserved_entry_ids: Vec::new(),
                preserved_message_count,
                created_at,
            },
        };
        append_transcript_entry(state, target_session_id, &duplicated)?;
    }
    let summary = session_bundle_summary_from_messages(&bundle.messages);
    let meta = session_transcript_metadata_snapshot(
        state,
        target_session_id,
        &bundle.runtime_mode,
        &bundle.protocol,
        bundle.model_name.as_deref(),
        bundle.message_count,
        &bundle.updated_at,
        &summary,
    )?;
    update_session_transcript_index(state, meta)
}
