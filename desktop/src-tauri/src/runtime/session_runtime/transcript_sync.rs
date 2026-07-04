use super::*;

pub(super) fn transcript_message_entries(
    entries: &[SessionTranscriptFileEntry],
) -> Vec<(String, Value)> {
    entries
        .iter()
        .filter_map(|entry| match entry {
            SessionTranscriptFileEntry::Message {
                entry_id, message, ..
            } if !is_internal_runtime_bundle_message(message) => {
                Some((entry_id.clone(), message.clone()))
            }
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

fn matched_bundle_message_prefix_len(
    existing_messages: &[(String, Value)],
    bundle_messages: &[Value],
) -> usize {
    let mut existing_index = 0usize;
    let mut matched = 0usize;
    for bundle_message in bundle_messages {
        let Some(next_existing_offset) = existing_messages[existing_index..]
            .iter()
            .position(|(_, existing_message)| existing_message == bundle_message)
        else {
            break;
        };
        existing_index += next_existing_offset + 1;
        matched += 1;
    }
    matched
}

pub(super) fn sync_transcript_from_bundle(
    state: &State<'_, AppState>,
    bundle: &SessionRuntimeBundle,
) -> Result<(), String> {
    let existing_entries = load_transcript_entries(state, &bundle.session_id)?;
    let existing_messages = transcript_message_entries(&existing_entries);
    let visible_bundle_messages = compact_bundle_messages(&bundle.messages)
        .into_iter()
        .filter(|message| !is_internal_runtime_bundle_message(message))
        .collect::<Vec<_>>();
    let prefix_len =
        matched_bundle_message_prefix_len(&existing_messages, &visible_bundle_messages);
    for message in visible_bundle_messages.iter().skip(prefix_len) {
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
    let summary = session_bundle_summary_from_messages(&visible_bundle_messages);
    let mut meta = session_transcript_metadata_snapshot(
        state,
        &bundle.session_id,
        &bundle.runtime_mode,
        &bundle.protocol,
        bundle.model_name.as_deref(),
        visible_bundle_messages.len() as i64,
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

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::matched_bundle_message_prefix_len;

    #[test]
    fn bundle_prefix_matching_tolerates_tool_messages_in_transcript() {
        let user = json!({ "role": "user", "content": "start" });
        let assistant_one = json!({ "role": "assistant", "content": "step one" });
        let tool = json!({ "role": "tool", "content": "tool result" });
        let assistant_two = json!({ "role": "assistant", "content": "step two" });
        let next_user = json!({ "role": "user", "content": "next" });

        let existing = vec![
            ("entry-1".to_string(), user.clone()),
            ("entry-2".to_string(), assistant_one.clone()),
            ("entry-3".to_string(), tool),
            ("entry-4".to_string(), assistant_two.clone()),
        ];
        let bundle = vec![user, assistant_one, assistant_two, next_user];

        assert_eq!(matched_bundle_message_prefix_len(&existing, &bundle), 3);
    }

    #[test]
    fn bundle_prefix_matching_skips_internal_skill_activation_messages() {
        let user = json!({ "role": "user", "content": "start" });
        let _internal = json!({
            "role": "user",
            "content": "系统状态更新：以下技能已激活并加入当前轮上下文：content-topic-miner。技能激活只会更新当前上下文。"
        });
        let assistant = json!({ "role": "assistant", "content": "done" });

        let existing = vec![
            ("entry-1".to_string(), user.clone()),
            ("entry-2".to_string(), assistant.clone()),
        ];
        let bundle = vec![user, assistant];

        assert_eq!(matched_bundle_message_prefix_len(&existing, &bundle), 2);
    }
}
