use super::*;

pub(super) fn transcript_message_entries(
    entries: &[SessionTranscriptFileEntry],
) -> Vec<(String, Value)> {
    entries
        .iter()
        .filter_map(|entry| match entry {
            SessionTranscriptFileEntry::Message {
                entry_id, message, ..
            } => Some((entry_id.clone(), message.clone())),
            _ => None,
        })
        .collect()
}

pub(super) fn rebuild_messages_after_last_compaction(
    entries: &[SessionTranscriptFileEntry],
) -> (Vec<Value>, Option<String>, Vec<String>) {
    let message_entries = transcript_message_entries(entries);
    let mut summary_prompt: Option<String> = None;
    let mut preserved_ids = Vec::<String>::new();
    let mut start_idx = 0usize;
    for (idx, entry) in entries.iter().enumerate() {
        if let SessionTranscriptFileEntry::CompactBoundary {
            summary,
            preserved_entry_ids,
            ..
        } = entry
        {
            summary_prompt = Some(summary.clone());
            preserved_ids = preserved_entry_ids.clone();
            start_idx = idx + 1;
        }
    }
    if summary_prompt.is_none() {
        return (
            message_entries
                .into_iter()
                .map(|(_, message)| message)
                .collect::<Vec<_>>(),
            None,
            Vec::new(),
        );
    }

    let mut messages = Vec::<Value>::new();
    let preserved_set = preserved_ids
        .iter()
        .cloned()
        .collect::<std::collections::HashSet<_>>();
    for (entry_id, message) in transcript_message_entries(entries) {
        if preserved_set.contains(&entry_id) {
            messages.push(message);
        }
    }
    for entry in &entries[start_idx..] {
        if let SessionTranscriptFileEntry::Message { message, .. } = entry {
            messages.push(message.clone());
        }
    }
    (messages, summary_prompt, preserved_ids)
}

pub(super) fn sync_transcript_from_bundle(
    state: &State<'_, AppState>,
    bundle: &SessionRuntimeBundle,
) -> Result<(), String> {
    let existing_entries = load_transcript_entries(state, &bundle.session_id)?;
    let existing_messages = transcript_message_entries(&existing_entries);
    let prefix_len = existing_messages
        .iter()
        .zip(bundle.messages.iter())
        .take_while(|((_, left), right)| left == *right)
        .count();
    for message in bundle.messages.iter().skip(prefix_len) {
        append_transcript_entry(
            state,
            &bundle.session_id,
            &SessionTranscriptFileEntry::Message {
                entry_id: make_id("entry"),
                session_id: bundle.session_id.clone(),
                message: message.clone(),
                created_at: now_iso(),
            },
        )?;
    }
    let summary = session_bundle_summary_from_messages(&bundle.messages);
    let mut meta = session_transcript_metadata_snapshot(
        state,
        &bundle.session_id,
        &bundle.runtime_mode,
        &bundle.protocol,
        bundle.model_name.as_deref(),
        bundle.message_count,
        &bundle.updated_at,
        &summary,
    )?;
    let metadata = SessionTranscriptFileEntry::Metadata {
        entry_id: make_id("entry"),
        session_id: bundle.session_id.clone(),
        title: Some(meta.title.clone()),
        tag: meta.tag.clone(),
        git_branch: meta.git_branch.clone(),
        worktree_path: meta.worktree_path.clone(),
        pr_number: meta.pr_number,
        pr_url: meta.pr_url.clone(),
        mode: meta.mode.clone(),
        runtime_mode: Some(meta.runtime_mode.clone()),
        protocol: Some(meta.protocol.clone()),
        model_name: meta.model_name.clone(),
        created_at: now_iso(),
    };
    append_transcript_entry(state, &bundle.session_id, &metadata)?;
    meta.has_compaction = existing_entries
        .iter()
        .any(|entry| matches!(entry, SessionTranscriptFileEntry::CompactBoundary { .. }));
    update_session_transcript_index(state, meta)
}
