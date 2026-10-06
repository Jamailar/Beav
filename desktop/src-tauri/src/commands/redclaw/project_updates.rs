use serde_json::{json, Value};
use tauri::State;

use crate::memory::append_memory_record;
use crate::persistence::with_store_mut;
use crate::store::{redclaw as redclaw_store, spaces as spaces_store};
use crate::{now_i64, now_iso, payload_string, AppState, UserMemoryRecord};

pub(super) fn update_redclaw_learning_candidate(
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let project_id =
        payload_string(payload, "projectId").ok_or_else(|| "projectId is required".to_string())?;
    let candidate_id = payload_string(payload, "candidateId")
        .ok_or_else(|| "candidateId is required".to_string())?;
    let status = payload_string(payload, "status").unwrap_or_else(|| "accepted".to_string());
    if !matches!(status.as_str(), "accepted" | "rejected" | "pending") {
        return Err("status must be accepted, rejected, or pending".to_string());
    }
    let now = now_iso();
    with_store_mut(state, |store| {
        let active_space_id = spaces_store::active_space_id(store);
        let (project, candidate_snapshot) = redclaw_store::update_learning_candidate_status(
            store,
            &project_id,
            &candidate_id,
            &status,
            &now,
        )?;
        if status == "accepted" {
            append_memory_record(
                store,
                redclaw_learning_memory_record(
                    &candidate_snapshot,
                    active_space_id,
                    &project_id,
                    &candidate_id,
                ),
            );
        }
        Ok(json!({
            "success": true,
            "project": project,
            "candidate": candidate_snapshot
        }))
    })
}

fn redclaw_learning_memory_record(
    candidate_snapshot: &Value,
    active_space_id: String,
    project_id: &str,
    candidate_id: &str,
) -> UserMemoryRecord {
    let statement = candidate_snapshot
        .get("statement")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .unwrap_or("RedClaw learning candidate accepted")
        .to_string();
    UserMemoryRecord {
        id: crate::make_id("memory"),
        content: statement,
        r#type: "redclaw_learning".to_string(),
        tags: vec!["redclaw".to_string(), "learning".to_string()],
        entities: Vec::new(),
        scope: Some(
            candidate_snapshot
                .get("scope")
                .and_then(Value::as_str)
                .unwrap_or("project")
                .to_string(),
        ),
        space_id: Some(active_space_id),
        project_id: Some(project_id.to_string()),
        session_id: None,
        source: Some(json!({
            "kind": "redclaw_learning_candidate",
            "projectId": project_id,
            "candidateId": candidate_id,
            "candidate": candidate_snapshot,
        })),
        confidence: candidate_snapshot.get("confidence").and_then(Value::as_f64),
        created_at: now_i64(),
        updated_at: None,
        last_accessed: None,
        status: Some("active".to_string()),
        archived_at: None,
        archive_reason: None,
        origin_id: None,
        canonical_key: None,
        revision: Some(1),
        last_conflict_at: None,
    }
}

pub(super) fn update_redclaw_project_section(
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let project_id =
        payload_string(payload, "projectId").ok_or_else(|| "projectId is required".to_string())?;
    let section_id =
        payload_string(payload, "sectionId").ok_or_else(|| "sectionId is required".to_string())?;
    let content =
        payload_string(payload, "content").ok_or_else(|| "content is required".to_string())?;
    let allowed = [
        "brief",
        "script",
        "storyboard",
        "media",
        "publish",
        "review",
        "research",
    ];
    if !allowed.iter().any(|item| item == &section_id.as_str()) {
        return Err("sectionId is not supported".to_string());
    }
    let now = now_iso();
    with_store_mut(state, |store| {
        let project = redclaw_store::update_project_section_draft(
            store,
            &project_id,
            &section_id,
            content,
            &now,
        )?;
        Ok(json!({
            "success": true,
            "project": project,
            "sectionId": section_id
        }))
    })
}
