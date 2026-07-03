use super::*;

fn manuscript_write_proposal_by_file_path(
    store: &AppStore,
    file_path: &str,
) -> Option<ManuscriptWriteProposalRecord> {
    let normalized = normalize_relative_path(file_path);
    store
        .manuscript_write_proposals
        .iter()
        .find(|item| normalize_relative_path(&item.file_path) == normalized)
        .cloned()
}

pub(crate) fn get_manuscript_write_proposal(
    state: &State<'_, AppState>,
    file_path: &str,
) -> Result<Option<ManuscriptWriteProposalRecord>, String> {
    with_store(state, |store| {
        Ok(manuscript_write_proposal_by_file_path(&store, file_path))
    })
}

pub(crate) fn upsert_manuscript_write_proposal(
    app: &AppHandle,
    state: &State<'_, AppState>,
    proposal: ManuscriptWriteProposalRecord,
) -> Result<ManuscriptWriteProposalRecord, String> {
    let saved = with_store_mut(state, |store| {
        let normalized = normalize_relative_path(&proposal.file_path);
        store
            .manuscript_write_proposals
            .retain(|item| normalize_relative_path(&item.file_path) != normalized);
        store.manuscript_write_proposals.push(proposal.clone());
        Ok(proposal.clone())
    })?;
    crate::events::emit_manuscript_write_proposal_changed(
        app,
        &saved.file_path,
        Some(json!(saved.clone())),
    );
    Ok(saved)
}

pub(crate) fn reject_manuscript_write_proposal(
    app: &AppHandle,
    state: &State<'_, AppState>,
    file_path: &str,
) -> Result<bool, String> {
    let normalized = normalize_relative_path(file_path);
    let removed = with_store_mut(state, |store| {
        let before = store.manuscript_write_proposals.len();
        store
            .manuscript_write_proposals
            .retain(|item| normalize_relative_path(&item.file_path) != normalized);
        Ok(before != store.manuscript_write_proposals.len())
    })?;
    if removed {
        crate::events::emit_manuscript_write_proposal_changed(app, file_path, None);
    }
    Ok(removed)
}

pub(crate) fn accept_manuscript_write_proposal(
    app: &AppHandle,
    state: &State<'_, AppState>,
    file_path: &str,
    proposed_content_override: Option<String>,
) -> Result<Value, String> {
    let proposal = get_manuscript_write_proposal(state, file_path)?
        .ok_or_else(|| "未找到待审改稿提案".to_string())?;
    let accepted_content =
        proposed_content_override.unwrap_or_else(|| proposal.proposed_content.clone());
    let saved = save_manuscript_content(
        state,
        &proposal.file_path,
        &accepted_content,
        proposal.metadata.as_ref().and_then(Value::as_object),
        "ai-proposal-accepted",
    )?;
    let _ = reject_manuscript_write_proposal(app, state, &proposal.file_path)?;
    crate::events::emit_manuscripts_changed(app, "save", &proposal.file_path);
    let mut object = saved.as_object().cloned().unwrap_or_default();
    object.insert("proposalId".to_string(), json!(proposal.id));
    object.insert("filePath".to_string(), json!(proposal.file_path));
    object.insert("content".to_string(), json!(accepted_content));
    Ok(Value::Object(object))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lookup_normalizes_proposal_paths() {
        let mut store = AppStore::default();
        store
            .manuscript_write_proposals
            .push(ManuscriptWriteProposalRecord {
                id: "proposal-1".to_string(),
                file_path: "drafts/story.md".to_string(),
                session_id: None,
                tool_call_id: None,
                draft_type: None,
                title: None,
                metadata: None,
                base_content: "old".to_string(),
                proposed_content: "new".to_string(),
                created_at: "1".to_string(),
                updated_at: "1".to_string(),
            });

        let found = manuscript_write_proposal_by_file_path(&store, "/drafts/story.md");
        assert_eq!(
            found.map(|proposal| proposal.id),
            Some("proposal-1".to_string())
        );
    }
}
