use serde_json::{json, Map, Value};
use tauri::{AppHandle, Emitter, State};

use crate::agent::{execute_prepared_session_agent_turn, PreparedSessionAgentTurn, RedclawRunTurn};
use crate::commands::chat_state::{apply_context_binding_metadata, ensure_chat_session};
use crate::persistence::{with_store, with_store_mut};
use crate::store::{spaces as spaces_store, work_items as work_items_store};
use crate::{
    create_work_item, make_id, now_iso, redclaw_root, resolve_manuscript_path,
    slug_from_relative_path, write_text_file, AppState, ChatMessageRecord,
};

pub fn redclaw_session_id_for_space(space_id: &str) -> String {
    let context_id = redclaw_context_id_for_space(space_id);
    format!(
        "context-session:redclaw:{}",
        slug_from_relative_path(&context_id)
    )
}

pub fn redclaw_context_id_for_space(space_id: &str) -> String {
    format!("redclaw-singleton:{space_id}")
}

fn apply_redclaw_runtime_metadata(
    session: &mut crate::ChatSessionRecord,
    active_space_id: &str,
    context_id: &str,
    source_kind: Option<&str>,
    source_task_id: Option<&str>,
) {
    apply_context_binding_metadata(session, "redclaw", context_id, None);
    let space_id = active_space_id.trim();
    let mut metadata = session
        .metadata
        .clone()
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    metadata.insert("surface".to_string(), json!("redclaw"));
    metadata.insert("runtimeSurface".to_string(), json!("redclaw"));
    metadata.insert("runtimeMode".to_string(), json!("redclaw"));

    let mut redclaw_context = Map::new();
    redclaw_context.insert("surface".to_string(), json!("redclaw"));
    redclaw_context.insert("spaceId".to_string(), json!(space_id));
    redclaw_context.insert("contextId".to_string(), json!(context_id));
    redclaw_context.insert(
        "profileContext".to_string(),
        json!({
            "kind": "redclaw-profile",
            "spaceId": space_id
        }),
    );
    if let Some(kind) = source_kind.map(str::trim).filter(|value| !value.is_empty()) {
        redclaw_context.insert("sourceKind".to_string(), json!(kind));
    }
    if let Some(task_id) = source_task_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        redclaw_context.insert("sourceTaskId".to_string(), json!(task_id));
    }
    metadata.insert("redclawContext".to_string(), Value::Object(redclaw_context));
    session.metadata = Some(Value::Object(metadata));
}

pub fn redclaw_session_id_for_task(
    space_id: &str,
    source_kind: &str,
    source_task_id: &str,
) -> String {
    let context_id = format!("automation:{space_id}:{source_kind}:{source_task_id}");
    format!(
        "context-session:redclaw:{}",
        slug_from_relative_path(&context_id)
    )
}

pub fn ensure_redclaw_task_session_record(
    state: &State<'_, AppState>,
    source_kind: Option<&str>,
    source_task_id: Option<&str>,
    title: &str,
) -> Result<String, String> {
    let active_space_id = with_store(state, |store| Ok(spaces_store::active_space_id(&store)))?;
    let context_id = redclaw_context_id_for_space(&active_space_id);
    let session_id = match (source_kind, source_task_id) {
        (Some(kind), Some(task_id)) if !kind.trim().is_empty() && !task_id.trim().is_empty() => {
            redclaw_session_id_for_task(&active_space_id, kind, task_id)
        }
        _ => redclaw_session_id_for_space(&active_space_id),
    };
    let session_title = if title.trim().is_empty() {
        "RedClaw 自动化".to_string()
    } else {
        title.trim().to_string()
    };
    with_store_mut(state, |store| {
        let (session, _) = ensure_chat_session(
            &mut store.chat_sessions,
            Some(session_id.clone()),
            Some(session_title.clone()),
        );
        apply_redclaw_runtime_metadata(
            session,
            &active_space_id,
            &context_id,
            source_kind,
            source_task_id,
        );
        session.updated_at = now_iso();
        Ok(session.id.clone())
    })
}

pub fn append_redclaw_automation_user_message(
    state: &State<'_, AppState>,
    session_id: &str,
    message: &str,
    execution_id: &str,
) -> Result<(), String> {
    let next_session_id = session_id.trim();
    let next_message = message.trim();
    let next_execution_id = execution_id.trim();
    if next_session_id.is_empty() || next_message.is_empty() || next_execution_id.is_empty() {
        return Ok(());
    }
    with_store_mut(state, |store| {
        let already_exists = store.chat_messages.iter().any(|item| {
            item.session_id == next_session_id
                && item.role == "user"
                && item
                    .metadata
                    .as_ref()
                    .and_then(|metadata| metadata.get("automationExecutionId"))
                    .and_then(Value::as_str)
                    == Some(next_execution_id)
        });
        if already_exists {
            return Ok(());
        }
        store.chat_messages.push(ChatMessageRecord {
            id: make_id("message"),
            session_id: next_session_id.to_string(),
            role: "user".to_string(),
            content: next_message.to_string(),
            display_content: None,
            attachment: None,
            metadata: Some(json!({
                "kind": "redclaw-automation-user",
                "automationExecutionId": next_execution_id,
            })),
            created_at: now_iso(),
        });
        Ok(())
    })
}

pub fn detect_redclaw_artifact_kind(prompt: &str, source_label: &str) -> &'static str {
    let lower = prompt.to_lowercase();
    if lower.contains("save-copy") || lower.contains("文案包") {
        "copy"
    } else if lower.contains("save-image") || lower.contains("配图") || lower.contains("封面") {
        "image"
    } else if lower.contains("save-retro") || lower.contains("复盘") {
        "retro"
    } else if source_label.contains("scheduled") || source_label.contains("long-cycle") {
        "automation"
    } else {
        "run"
    }
}

pub fn save_redclaw_outputs(
    state: &State<'_, AppState>,
    kind: &str,
    session_id: &str,
    prompt: &str,
    response: &str,
    source_label: &str,
) -> Result<Vec<Value>, String> {
    let mut artifacts = Vec::new();
    let timestamp = now_iso();
    let slug = slug_from_relative_path(&format!("{session_id}-{source_label}-{timestamp}"));

    let run_path = redclaw_root(state)?.join("runs").join(format!("{slug}.md"));
    let run_body = format!(
        "# RedClaw Run\n\n- Source: {}\n- Session: {}\n- Time: {}\n\n## Prompt\n\n{}\n\n## Response\n\n{}\n",
        source_label, session_id, timestamp, prompt, response
    );
    write_text_file(&run_path, &run_body)?;
    artifacts.push(json!({
        "kind": "run-log",
        "path": run_path.display().to_string(),
        "label": "RedClaw run log",
    }));

    match kind {
        "copy" => {
            let manuscript_relative = format!("redclaw/{}.md", slug);
            let manuscript_path = resolve_manuscript_path(state, &manuscript_relative)?;
            let manuscript_body = format!(
                "# RedClaw Copy Package\n\n> Generated by: {}\n\n{}",
                source_label, response
            );
            write_text_file(&manuscript_path, &manuscript_body)?;
            artifacts.push(json!({
                "kind": "manuscript",
                "path": manuscript_path.display().to_string(),
                "relativePath": manuscript_relative,
                "label": "Copy package manuscript",
            }));
        }
        "retro" => {
            let retro_path = redclaw_root(state)?
                .join("retro")
                .join(format!("{slug}.md"));
            let retro_body = format!(
                "# RedClaw Retro\n\n> Generated by: {}\n\n{}",
                source_label, response
            );
            write_text_file(&retro_path, &retro_body)?;
            artifacts.push(json!({
                "kind": "retro",
                "path": retro_path.display().to_string(),
                "label": "Retro note",
            }));
        }
        "image" => {
            let prompt_path = redclaw_root(state)?
                .join("images")
                .join(format!("{slug}.md"));
            let prompt_body = format!(
                "# RedClaw Image Prompt Pack\n\n> Generated by: {}\n\n{}",
                source_label, response
            );
            write_text_file(&prompt_path, &prompt_body)?;
            artifacts.push(json!({
                "kind": "image-prompts",
                "path": prompt_path.display().to_string(),
                "label": "Image prompt pack",
            }));
        }
        _ => {}
    }

    Ok(artifacts)
}

fn execute_redclaw_run_in_session(
    app: &AppHandle,
    state: &State<'_, AppState>,
    prompt: String,
    source_label: &str,
    session_id: String,
    session_title: String,
    context_id: String,
    source_kind: Option<&str>,
    source_task_id: Option<&str>,
) -> Result<Value, String> {
    let _ = with_store_mut(state, |store| {
        let (session, _) = ensure_chat_session(
            &mut store.chat_sessions,
            Some(session_id.clone()),
            Some(session_title.clone()),
        );
        let active_space_id = context_id
            .strip_prefix("redclaw-singleton:")
            .unwrap_or("default");
        apply_redclaw_runtime_metadata(
            session,
            active_space_id,
            &context_id,
            source_kind,
            source_task_id,
        );
        session.updated_at = now_iso();
        Ok(session.id.clone())
    })?;
    let turn = PreparedSessionAgentTurn::redclaw_run(RedclawRunTurn::new_with_user_persistence(
        source_label,
        session_id.clone(),
        prompt.clone(),
        Some(session_title),
        false,
    ));
    let execution = execute_prepared_session_agent_turn(Some(app), state, &turn)?;

    let artifact_kind = detect_redclaw_artifact_kind(&prompt, source_label);
    let artifacts = save_redclaw_outputs(
        state,
        artifact_kind,
        &session_id,
        &prompt,
        execution.response(),
        source_label,
    )?;

    with_store_mut(state, |store| {
        work_items_store::push_item(
            store,
            create_work_item(
                "automation",
                format!("RedClaw {}", source_label),
                Some("Rust host executed a RedClaw run.".to_string()),
                Some(prompt.clone()),
                Some(json!({
                    "sessionId": execution.session_id(),
                    "source": source_label,
                    "artifactKind": artifact_kind,
                    "artifacts": artifacts,
                })),
                2,
            ),
        );

        Ok(())
    })?;

    let _ = app.emit(
        "redclaw:runner-message",
        json!({
            "sessionId": execution.session_id(),
            "artifactKind": artifact_kind,
            "artifacts": artifacts,
        }),
    );
    Ok(json!({
        "success": true,
        "sessionId": execution.session_id(),
        "response": execution.response(),
        "artifactKind": artifact_kind,
        "artifacts": artifacts
    }))
}

pub fn execute_redclaw_run(
    app: &AppHandle,
    state: &State<'_, AppState>,
    prompt: String,
    source_label: &str,
) -> Result<Value, String> {
    let active_space_id = with_store(state, |store| Ok(spaces_store::active_space_id(&store)))?;
    let session_id = redclaw_session_id_for_space(&active_space_id);
    let context_id = redclaw_context_id_for_space(&active_space_id);
    execute_redclaw_run_in_session(
        app,
        state,
        prompt,
        source_label,
        session_id,
        "RedClaw".to_string(),
        context_id,
        None,
        None,
    )
}

pub fn execute_redclaw_task_run(
    app: &AppHandle,
    state: &State<'_, AppState>,
    prompt: String,
    source_label: &str,
    source_kind: Option<&str>,
    source_task_id: Option<&str>,
    title: &str,
) -> Result<Value, String> {
    let session_title = if title.trim().is_empty() {
        "RedClaw 自动化".to_string()
    } else {
        title.trim().to_string()
    };
    let session_id =
        ensure_redclaw_task_session_record(state, source_kind, source_task_id, &session_title)?;
    let active_space_id = with_store(state, |store| Ok(spaces_store::active_space_id(&store)))?;
    let context_id = redclaw_context_id_for_space(&active_space_id);
    execute_redclaw_run_in_session(
        app,
        state,
        prompt,
        source_label,
        session_id,
        session_title,
        context_id,
        source_kind,
        source_task_id,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redclaw_runtime_metadata_adds_surface_space_and_task_context() {
        let mut session = crate::ChatSessionRecord {
            id: "session-1".to_string(),
            title: "RedClaw".to_string(),
            created_at: "1".to_string(),
            updated_at: "1".to_string(),
            metadata: Some(json!({
                "allowedTools": ["Operate"]
            })),
            starred: false,
            archived: false,
            archived_at: None,
            deleted_at: None,
        };

        apply_redclaw_runtime_metadata(
            &mut session,
            "default",
            "redclaw-singleton:default",
            Some("scheduled"),
            Some("task-1"),
        );

        let metadata = session.metadata.expect("metadata");
        assert_eq!(
            metadata.get("surface").and_then(Value::as_str),
            Some("redclaw")
        );
        assert_eq!(
            metadata.get("runtimeMode").and_then(Value::as_str),
            Some("redclaw")
        );
        assert_eq!(
            metadata
                .pointer("/redclawContext/spaceId")
                .and_then(Value::as_str),
            Some("default")
        );
        assert_eq!(
            metadata
                .pointer("/redclawContext/sourceTaskId")
                .and_then(Value::as_str),
            Some("task-1")
        );
        assert_eq!(
            metadata
                .get("allowedTools")
                .and_then(Value::as_array)
                .map(Vec::len),
            Some(1)
        );
    }
}
