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
            created_at: item
                .get("created_at")
                .or_else(|| item.get("createdAt"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToString::to_string)
                .unwrap_or_else(|| format!("bundle:{index:013}")),
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

fn bundle_message_key(message: &Value) -> Option<(String, String)> {
    let role = message.get("role")?.as_str()?.trim().to_string();
    if role.is_empty() {
        return None;
    }
    if role == "assistant" {
        if let Some(tool_calls) = message.get("tool_calls").and_then(Value::as_array) {
            if !tool_calls.is_empty() {
                let key = tool_calls
                    .iter()
                    .map(|tool_call| {
                        let call_id = tool_call
                            .get("id")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .trim();
                        let function = tool_call.get("function").unwrap_or(&Value::Null);
                        let name = function
                            .get("name")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .trim();
                        let arguments = function
                            .get("arguments")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .trim();
                        format!("{call_id}\u{1f}{name}\u{1f}{arguments}")
                    })
                    .collect::<Vec<_>>()
                    .join("\u{1e}");
                if !key.trim().is_empty() {
                    return Some((role, format!("tool_calls:{key}")));
                }
            }
        }
    }
    if role == "tool" {
        let call_id = message
            .get("tool_call_id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim();
        let tool_name = message
            .get("tool_name")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim();
        let content = message
            .get("content")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim();
        let key = format!("{call_id}\u{1f}{tool_name}\u{1f}{content}");
        if !key.trim().is_empty() {
            return Some((role, key));
        }
    }
    let content = message.get("content")?.as_str()?.trim().to_string();
    if content.is_empty() {
        return None;
    }
    Some((role, content))
}

fn visible_chat_message_count(messages: &[Value]) -> usize {
    messages
        .iter()
        .filter(|message| {
            !is_internal_runtime_bundle_message(message)
                && matches!(
                    message.get("role").and_then(Value::as_str),
                    Some("user" | "assistant")
                )
                && message
                    .get("content")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .map(|content| !content.is_empty())
                    .unwrap_or(false)
        })
        .count()
}

fn upsert_bundle_messages(base: &mut Vec<Value>, next: &[Value]) {
    let mut seen = base
        .iter()
        .enumerate()
        .filter_map(|(index, message)| bundle_message_key(message).map(|key| (key, index)))
        .collect::<std::collections::HashMap<_, _>>();
    for message in next {
        if let Some(key) = bundle_message_key(message) {
            if let Some(index) = seen.get(&key).copied() {
                base[index] = message.clone();
            } else {
                let index = base.len();
                base.push(message.clone());
                seen.insert(key, index);
            }
        } else {
            base.push(message.clone());
        }
    }
}

pub(super) fn compact_bundle_messages(messages: &[Value]) -> Vec<Value> {
    let mut compacted = Vec::<Value>::new();
    upsert_bundle_messages(&mut compacted, messages);
    compacted
}

fn merge_session_bundle_messages(
    existing: Option<&SessionRuntimeBundle>,
    next: &[Value],
    chat_snapshot: &[Value],
) -> Vec<Value> {
    let mut merged = existing
        .filter(|bundle| bundle.messages.len() > next.len())
        .map(|bundle| compact_bundle_messages(&bundle.messages))
        .unwrap_or_else(|| next.to_vec());
    if let Some(bundle) = existing {
        upsert_bundle_messages(&mut merged, &bundle.messages);
    }
    upsert_bundle_messages(&mut merged, next);

    if chat_snapshot.len() > visible_chat_message_count(&merged) {
        let previous = merged;
        merged = chat_snapshot.to_vec();
        upsert_bundle_messages(&mut merged, &previous);
    } else {
        upsert_bundle_messages(&mut merged, chat_snapshot);
    }
    compact_bundle_messages(&merged)
}

#[cfg(test)]
mod tests {
    use serde_json::{json, Value};

    use super::{merge_session_bundle_messages, visible_chat_message_count};

    #[test]
    fn bundle_save_merge_restores_chat_messages_missing_from_provider_snapshot() {
        let next = vec![
            json!({ "role": "user", "content": "你可以保存小红书url到知识库吗" }),
            json!({ "role": "assistant", "content": "请提供要保存的小红书笔记链接。" }),
            json!({ "role": "user", "content": "你没有相应的工具吗" }),
            json!({ "role": "assistant", "content": "请给我具体的小红书 URL。" }),
        ];
        let chat_snapshot = vec![
            json!({ "role": "user", "content": "你可以保存小红书url到知识库吗" }),
            json!({ "role": "assistant", "content": "请提供要保存的小红书笔记链接。" }),
            json!({ "role": "user", "content": "http://xhslink.com/o/6ea4DsyOJtR" }),
            json!({ "role": "user", "content": "你没有相应的工具吗" }),
            json!({ "role": "assistant", "content": "请给我具体的小红书 URL。" }),
        ];

        let merged = merge_session_bundle_messages(None, &next, &chat_snapshot);

        assert_eq!(visible_chat_message_count(&merged), 5);
        assert_eq!(
            merged
                .get(2)
                .and_then(|message| message.get("content"))
                .and_then(Value::as_str),
            Some("http://xhslink.com/o/6ea4DsyOJtR")
        );
    }

    #[test]
    fn bundle_save_merge_collapses_duplicate_tool_call_snapshots() {
        let repeated_tool_call = json!({
            "role": "assistant",
            "content": "",
            "tool_calls": [{
                "id": "call-1",
                "type": "function",
                "function": {
                    "name": "Read",
                    "arguments": "{\"path\":\"references/guide.md\"}"
                }
            }]
        });
        let next = vec![
            json!({ "role": "user", "content": "use skill" }),
            repeated_tool_call.clone(),
            repeated_tool_call.clone(),
            json!({
                "role": "tool",
                "tool_call_id": "call-1",
                "tool_name": "workflow",
                "content": "{\"ok\":true}"
            }),
        ];
        let chat_snapshot = vec![
            json!({ "role": "user", "content": "use skill" }),
            json!({ "role": "assistant", "content": "done" }),
        ];

        let merged = merge_session_bundle_messages(None, &next, &chat_snapshot);
        let tool_call_snapshot_count = merged
            .iter()
            .filter(|message| message.get("tool_calls").is_some())
            .count();

        assert_eq!(tool_call_snapshot_count, 1);
        assert_eq!(visible_chat_message_count(&merged), 2);
    }
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
    let chat_snapshot = with_store(state, |store| {
        Ok(chat_messages_for_session(&store, &resolved_session_id)
            .into_iter()
            .map(runtime_history_message_from_chat_record)
            .collect::<Vec<_>>())
    })
    .unwrap_or_default();
    let merged_messages =
        merge_session_bundle_messages(existing.as_ref(), messages, &chat_snapshot);
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
        message_count: merged_messages.len() as i64,
        updated_at: now_iso(),
        messages: merged_messages,
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
    bundle.messages = compact_bundle_messages(&bundle.messages)
        .into_iter()
        .filter(|message| !is_internal_runtime_bundle_message(message))
        .collect();
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
