use super::*;

pub fn session_message_count_for_session(store: &AppStore, session_id: &str) -> i64 {
    chat_messages_for_session(store, session_id).len() as i64
}

pub fn session_summary_text_for_session(store: &AppStore, session_id: &str) -> String {
    if let Some(summary) = store
        .session_context_records
        .iter()
        .find(|item| item.session_id == session_id)
        .map(|item| item.summary.clone())
        .filter(|item| !item.trim().is_empty())
    {
        return summary;
    }
    chat_messages_for_session(store, session_id)
        .into_iter()
        .find(|item| item.role == "user")
        .map(|item| snippet(&item.content, 120))
        .unwrap_or_default()
}

pub fn session_context_value_for_session(store: &AppStore, session_id: &str) -> Value {
    store
        .session_context_records
        .iter()
        .find(|item| item.session_id == session_id)
        .map(session_context_record_value)
        .unwrap_or(Value::Null)
}

pub fn session_context_usage_value(store: &AppStore, session_id: &str) -> Value {
    let messages = chat_messages_for_session(store, session_id);
    let total_chars = messages
        .iter()
        .map(|item| item.content.chars().count() as i64)
        .sum::<i64>();
    let estimated_total_tokens = estimate_tokens_from_chars(total_chars);
    let context = store
        .session_context_records
        .iter()
        .find(|item| item.session_id == session_id);
    let compact_threshold = session_compact_target_tokens(store);
    let compacted_message_count = context
        .map(|item| item.compacted_message_count)
        .unwrap_or(0);
    let compact_rounds = context.map(|item| item.compact_rounds).unwrap_or(0);
    let compact_updated_at = context
        .map(|item| Value::String(item.updated_at.clone()))
        .unwrap_or(Value::Null);
    let summary_chars = context.map(|item| item.summary_chars).unwrap_or(0);
    let estimated_effective_tokens = estimate_tokens_from_chars(if compacted_message_count > 0 {
        summary_chars
            + messages
                .iter()
                .rev()
                .take(SESSION_CONTEXT_TAIL_MESSAGES)
                .map(|item| item.content.chars().count() as i64)
                .sum::<i64>()
    } else {
        total_chars
    });
    let effective_messages = if compacted_message_count > 0 {
        compacted_message_count.min(1) + messages.len().min(SESSION_CONTEXT_TAIL_MESSAGES) as i64
    } else {
        messages.len() as i64
    };

    json!({
        "success": true,
        "estimatedTotalTokens": estimated_total_tokens,
        "estimatedEffectiveTokens": estimated_effective_tokens,
        "totalMessages": messages.len(),
        "effectiveMessages": effective_messages,
        "compactedMessageCount": compacted_message_count,
        "recentMessageCount": messages.len().min(SESSION_CONTEXT_TAIL_MESSAGES),
        "compactThreshold": compact_threshold,
        "compactRatio": if compact_threshold <= 0 {
            0.0
        } else {
            estimated_effective_tokens as f64 / compact_threshold as f64
        },
        "compactRounds": compact_rounds,
        "compactUpdatedAt": compact_updated_at,
        "summaryChars": summary_chars,
    })
}

pub fn update_session_context_record(
    store: &mut AppStore,
    session_id: &str,
    source: &str,
    force: bool,
) -> Option<ChatSessionContextRecord> {
    let messages = chat_messages_for_session(store, session_id);
    let total_chars = messages
        .iter()
        .map(|item| item.content.chars().count() as i64)
        .sum::<i64>();
    let estimated_total_tokens = estimate_tokens_from_chars(total_chars);
    let compact_target_tokens = session_compact_target_tokens(store);
    let meets_auto_threshold = messages.len() >= SESSION_AUTO_COMPACT_MIN_MESSAGES
        && estimated_total_tokens >= compact_target_tokens;
    let can_force_compact = messages.len() > SESSION_CONTEXT_TAIL_MESSAGES;

    if (!force && !meets_auto_threshold) || (force && !can_force_compact) {
        store
            .session_context_records
            .retain(|item| item.session_id != session_id);
        return None;
    }

    let archived_count = messages.len().saturating_sub(SESSION_CONTEXT_TAIL_MESSAGES);
    if archived_count == 0 {
        return None;
    }
    let archived = &messages[..archived_count];
    let existing = store
        .session_context_records
        .iter()
        .find(|item| item.session_id == session_id)
        .cloned();
    let summary = build_session_context_summary(archived);
    let record = ChatSessionContextRecord {
        session_id: session_id.to_string(),
        summary_chars: summary.chars().count() as i64,
        summary,
        summary_source: source.to_string(),
        total_message_count: messages.len() as i64,
        compacted_message_count: archived_count as i64,
        tail_message_count: messages.len().min(SESSION_CONTEXT_TAIL_MESSAGES) as i64,
        compact_rounds: match (existing.as_ref(), force) {
            (Some(item), true) => item.compact_rounds + 1,
            (Some(item), false) => item.compact_rounds.max(1),
            (None, _) => 1,
        },
        estimated_total_tokens,
        first_user_message: messages
            .iter()
            .find(|item| item.role == "user")
            .map(|item| snippet(&item.content, 160)),
        last_user_message: messages
            .iter()
            .rev()
            .find(|item| item.role == "user")
            .map(|item| snippet(&item.content, 200)),
        last_assistant_message: messages
            .iter()
            .rev()
            .find(|item| item.role == "assistant")
            .map(|item| snippet(&item.content, 200)),
        updated_at: now_iso(),
    };
    if let Some(existing_index) = store
        .session_context_records
        .iter()
        .position(|item| item.session_id == session_id)
    {
        store.session_context_records[existing_index] = record.clone();
    } else {
        store.session_context_records.push(record.clone());
    }
    Some(record)
}

pub fn append_compact_boundary_entry(
    state: &State<'_, AppState>,
    _store: &AppStore,
    session_id: &str,
    summary: &str,
) -> Result<(), String> {
    let entries = load_transcript_entries(state, session_id)?;
    let message_entries = transcript_message_entries(&entries);
    let preserve_from = message_entries
        .len()
        .saturating_sub(SESSION_CONTEXT_TAIL_MESSAGES);
    let preserved_entry_ids = message_entries[preserve_from..]
        .iter()
        .map(|(entry_id, _)| entry_id.clone())
        .collect::<Vec<_>>();
    append_transcript_entry(
        state,
        session_id,
        &SessionTranscriptFileEntry::CompactBoundary {
            entry_id: make_id("entry"),
            session_id: session_id.to_string(),
            summary: summary.to_string(),
            preserved_message_count: preserved_entry_ids.len() as i64,
            preserved_entry_ids,
            created_at: now_iso(),
        },
    )?;
    let resolved = resolve_session_id_or_latest(state, session_id)?;
    let mut index = load_session_transcript_file_index(state)?;
    if let Some(meta) = index
        .sessions
        .iter_mut()
        .find(|item| item.session_id == resolved)
    {
        meta.has_compaction = true;
        meta.summary = snippet(summary, 80);
        meta.updated_at = now_iso();
    }
    persist_session_transcript_file_index(state, &index)
}

pub fn runtime_context_messages_for_session(
    state: Option<&State<'_, AppState>>,
    store: &AppStore,
    session_id: &str,
    limit: usize,
) -> Vec<Value> {
    let initial_context_prompt = session_initial_context_prompt(store, session_id);
    if let Some(state) = state {
        if let Ok(bundle_messages) = load_session_bundle_messages(state, session_id) {
            let sanitized_messages = sanitize_runtime_history_messages(&bundle_messages);
            if !sanitized_messages.is_empty() {
                let mut result = bundle_messages_for_runtime(
                    &sanitized_messages,
                    session_resume_summary_prompt(store, session_id),
                    limit,
                );
                if let Some(prompt) = initial_context_prompt.as_deref() {
                    result.insert(
                        0,
                        json!({
                            "role": "user",
                            "content": prompt
                        }),
                    );
                }
                return result;
            }
        }
    }

    let items = chat_messages_for_session(store, session_id)
        .into_iter()
        .map(runtime_history_message_from_chat_record)
        .collect::<Vec<_>>();
    let items = sanitize_runtime_history_messages(&items);
    let mut result = bundle_messages_for_runtime(
        &items,
        session_resume_summary_prompt(store, session_id),
        limit,
    );
    if let Some(prompt) = initial_context_prompt.as_deref() {
        result.insert(
            0,
            json!({
                "role": "user",
                "content": prompt
            }),
        );
    }
    result
}

fn session_context_record_value(record: &ChatSessionContextRecord) -> Value {
    json!({
        "sessionId": record.session_id,
        "summary": record.summary,
        "summarySource": record.summary_source,
        "totalMessageCount": record.total_message_count,
        "compactedMessageCount": record.compacted_message_count,
        "tailMessageCount": record.tail_message_count,
        "compactRounds": record.compact_rounds,
        "summaryChars": record.summary_chars,
        "estimatedTotalTokens": record.estimated_total_tokens,
        "firstUserMessage": record.first_user_message,
        "lastUserMessage": record.last_user_message,
        "lastAssistantMessage": record.last_assistant_message,
        "updatedAt": record.updated_at,
    })
}

fn session_resume_summary_prompt(store: &AppStore, session_id: &str) -> Option<String> {
    store
        .session_context_records
        .iter()
        .find(|item| item.session_id == session_id && item.compacted_message_count > 0)
        .map(|item| {
            format!(
                "[Session resume summary]\n{}\n\nUse this archived context together with the recent messages below.",
                item.summary
            )
        })
}

fn session_initial_context_prompt(store: &AppStore, session_id: &str) -> Option<String> {
    store
        .chat_sessions
        .iter()
        .find(|item| item.id == session_id)
        .and_then(|session| session.metadata.as_ref())
        .and_then(|metadata| metadata.get("initialContext"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| format!("[Session initial context]\n{value}"))
}

pub fn bundle_messages_for_runtime(
    messages: &[Value],
    summary_prompt: Option<String>,
    limit: usize,
) -> Vec<Value> {
    if messages.is_empty() {
        return Vec::new();
    }
    let start = messages.len().saturating_sub(limit);
    let mut result = Vec::new();
    if start > 0 {
        if let Some(summary) = summary_prompt.filter(|item| !item.trim().is_empty()) {
            result.push(json!({
                "role": "user",
                "content": summary
            }));
        }
    }
    result.extend(messages[start..].iter().cloned());
    result
}
