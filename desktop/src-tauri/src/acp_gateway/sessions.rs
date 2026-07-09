use serde_json::{json, Map, Value};

use crate::runtime::{
    create_collab_session, ensure_collab_session_coordinator, post_collab_message,
};
use crate::session_manager::create_session;
use crate::store::spaces as spaces_store;
use crate::{
    append_session_transcript, AcpMessageRecord, AcpSessionRecord, AppStore, ChatMessageRecord,
};

use super::audit::append_acp_audit_event;
use super::errors::AcpHttpError;
use super::make_acp_id;
use super::types::{
    acp_session_id_from_payload, chat_session_attach_requested, client_from_payload_and_headers,
    collab_session_id_from_payload, payload_array_strings, payload_object, payload_string,
    project_ref_from_payload, prompt_from_payload, AcpRequestClient,
};

fn value_object(value: Option<Value>) -> Map<String, Value> {
    value
        .and_then(|item| item.as_object().cloned())
        .unwrap_or_default()
}

fn metadata_string(metadata: &Map<String, Value>, key: &str) -> Option<String> {
    metadata
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn metadata_nested_string(
    metadata: &Map<String, Value>,
    object_key: &str,
    key: &str,
) -> Option<String> {
    metadata
        .get(object_key)
        .and_then(Value::as_object)
        .and_then(|object| object.get(key))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn metadata_space_id(metadata: &Map<String, Value>) -> Option<String> {
    metadata_string(metadata, "spaceId")
        .or_else(|| metadata_string(metadata, "activeSpaceId"))
        .or_else(|| metadata_nested_string(metadata, "redclawContext", "spaceId"))
        .or_else(|| metadata_nested_string(metadata, "scope", "spaceId"))
}

fn copy_space_scope_metadata(target: &mut Map<String, Value>, source: Option<&Value>) {
    let Some(source) = source.and_then(Value::as_object) else {
        return;
    };
    if metadata_space_id(target).is_some() {
        return;
    }
    for key in [
        "spaceId",
        "activeSpaceId",
        "spaceName",
        "scope",
        "redclawContext",
    ] {
        if let Some(value) = source.get(key) {
            target.insert(key.to_string(), value.clone());
        }
    }
}

fn ensure_acp_space_scope_metadata(store: &AppStore, metadata: &mut Map<String, Value>) {
    let explicit_space_id = metadata_space_id(metadata);
    let (active_space_id, active_space_name) = spaces_store::active_workspace_snapshot(store);
    let space_id = explicit_space_id.unwrap_or(active_space_id);
    if space_id.trim().is_empty() {
        return;
    }
    let space_name = store
        .spaces
        .iter()
        .find(|space| space.id == space_id)
        .map(|space| space.name.clone())
        .unwrap_or_else(|| {
            metadata_string(metadata, "spaceName").unwrap_or_else(|| {
                if space_id == spaces_store::active_space_id(store) {
                    active_space_name
                } else {
                    space_id.clone()
                }
            })
        });
    metadata
        .entry("spaceId".to_string())
        .or_insert_with(|| json!(space_id.clone()));
    metadata
        .entry("activeSpaceId".to_string())
        .or_insert_with(|| json!(space_id.clone()));
    metadata
        .entry("spaceName".to_string())
        .or_insert_with(|| json!(space_name.clone()));
    metadata.entry("scope".to_string()).or_insert_with(|| {
        json!({
            "type": "space",
            "spaceId": space_id,
            "spaceName": space_name
        })
    });
}

fn acp_payload_metadata_with_scope(
    store: &AppStore,
    payload: &Value,
    fallback_metadata: Option<&Value>,
) -> Value {
    let mut metadata = value_object(payload_object(payload, "metadata"));
    copy_space_scope_metadata(&mut metadata, fallback_metadata);
    ensure_acp_space_scope_metadata(store, &mut metadata);
    Value::Object(metadata)
}

fn acp_chat_metadata(
    store: &AppStore,
    acp_session_id: &str,
    collab_session_id: &str,
    client: &AcpRequestClient,
    project_ref: Option<Value>,
    extra_metadata: Option<Value>,
) -> Value {
    let mut metadata = value_object(extra_metadata);
    ensure_acp_space_scope_metadata(store, &mut metadata);
    metadata.insert("source".to_string(), json!("acp"));
    metadata.insert("sourceLabel".to_string(), json!(client.source_label()));
    metadata.insert("isExternalAgentSession".to_string(), json!(true));
    metadata.insert("externalClientId".to_string(), json!(client.id.clone()));
    metadata.insert("externalClientName".to_string(), json!(client.name.clone()));
    metadata.insert("externalClientKind".to_string(), json!(client.kind.clone()));
    metadata.insert("acpSessionId".to_string(), json!(acp_session_id));
    metadata.insert("collabSessionId".to_string(), json!(collab_session_id));
    if let Some(project_ref) = project_ref {
        metadata.insert("projectRef".to_string(), project_ref);
    }
    Value::Object(metadata)
}

fn update_chat_session_metadata(
    store: &mut AppStore,
    chat_session_id: &str,
    metadata: Value,
) -> Result<(), AcpHttpError> {
    let session = store
        .chat_sessions
        .iter_mut()
        .find(|item| item.id == chat_session_id)
        .ok_or_else(|| {
            AcpHttpError::not_found("chat_session_not_found", "Chat session not found.")
        })?;
    session.metadata = Some(metadata);
    session.updated_at = crate::now_iso();
    Ok(())
}

fn ensure_acp_creator_member_id(
    store: &mut AppStore,
    collab_session_id: &str,
) -> Result<String, AcpHttpError> {
    let (_, member, _) = ensure_collab_session_coordinator(store, collab_session_id)
        .map_err(AcpHttpError::internal)?;
    Ok(member.id)
}

fn create_acp_session_record(
    acp_id: String,
    collab_session_id: String,
    chat_session_id: String,
    client: &AcpRequestClient,
    payload: &Value,
    title: String,
    objective: String,
    project_ref: Option<Value>,
    metadata: Value,
) -> AcpSessionRecord {
    let now = crate::now_i64();
    AcpSessionRecord {
        id: acp_id,
        external_session_id: payload_string(payload, "externalSessionId"),
        external_client_id: client.id.clone(),
        external_client_name: Some(client.name.clone()),
        external_client_kind: Some(client.kind.clone()),
        source_label: client.source_label(),
        collab_session_id,
        chat_session_id,
        project_ref,
        title,
        objective,
        status: "active".to_string(),
        metadata: Some(metadata),
        created_at: now,
        updated_at: now,
        last_message_at: None,
    }
}

fn acp_prompt_title_from_payload(payload: &Value) -> Option<String> {
    prompt_from_payload(payload)
        .map(|value| crate::session_title_from_message(&value))
        .filter(|value| !value.trim().is_empty() && value != "New Chat")
}

fn acp_prompt_title_from_history(store: &AppStore, acp_session_id: &str) -> Option<String> {
    store
        .acp_messages
        .iter()
        .filter(|item| item.session_id == acp_session_id && item.direction == "inbound")
        .min_by(|left, right| left.created_at.cmp(&right.created_at))
        .map(|item| crate::session_title_from_message(&item.content))
        .filter(|value| !value.trim().is_empty() && value != "New Chat")
}

fn is_acp_source_title(title: &str, client: &AcpRequestClient) -> bool {
    let normalized = title.trim();
    normalized == "External Agent Conversation"
        || normalized == "外部 Agent 对话"
        || normalized == format!("{} 与 RedBox 对话", client.name.trim())
}

fn repair_acp_source_title_if_needed(
    store: &mut AppStore,
    session: &AcpSessionRecord,
    client: &AcpRequestClient,
    payload: &Value,
) -> Result<(), AcpHttpError> {
    if !is_acp_source_title(&session.title, client) {
        return Ok(());
    }
    let Some(next_title) = acp_prompt_title_from_history(store, &session.id)
        .or_else(|| acp_prompt_title_from_payload(payload))
        .or_else(|| payload_string(payload, "title"))
        .filter(|value| !is_acp_source_title(value, client))
    else {
        return Ok(());
    };
    if let Some(chat_session) = store
        .chat_sessions
        .iter_mut()
        .find(|item| item.id == session.chat_session_id)
    {
        chat_session.title = next_title.clone();
        chat_session.updated_at = crate::now_iso();
    }
    if let Some(collab_session) = store
        .collab_sessions
        .iter_mut()
        .find(|item| item.id == session.collab_session_id)
    {
        collab_session.title = next_title.clone();
        collab_session.updated_at = crate::now_i64();
    }
    if let Some(acp_session) = store
        .acp_sessions
        .iter_mut()
        .find(|item| item.id == session.id)
    {
        acp_session.title = next_title;
        acp_session.updated_at = crate::now_i64();
    }
    Ok(())
}

pub(crate) fn session_public_value(store: &AppStore, session: &AcpSessionRecord) -> Value {
    let chat_session = store
        .chat_sessions
        .iter()
        .find(|item| item.id == session.chat_session_id)
        .map(|item| {
            json!({
                "id": item.id.clone(),
                "title": item.title.clone(),
                "createdAt": item.created_at.clone(),
                "updatedAt": item.updated_at.clone(),
                "metadata": item.metadata.clone()
            })
        })
        .unwrap_or(Value::Null);
    let collab_session = store
        .collab_sessions
        .iter()
        .find(|item| item.id == session.collab_session_id)
        .cloned();
    let coordinator_member_id = collab_session
        .as_ref()
        .and_then(|item| item.coordinator_member_id.clone());
    let collab_session = collab_session
        .map(|item| json!(item.clone()))
        .unwrap_or(Value::Null);
    let message_count = store
        .acp_messages
        .iter()
        .filter(|item| item.session_id == session.id)
        .count();
    json!({
        "id": session.id.clone(),
        "externalSessionId": session.external_session_id.clone(),
        "sourceLabel": session.source_label.clone(),
        "externalClientId": session.external_client_id.clone(),
        "externalClientName": session.external_client_name.clone(),
        "externalClientKind": session.external_client_kind.clone(),
        "title": session.title.clone(),
        "objective": session.objective.clone(),
        "status": session.status.clone(),
        "chatSessionId": session.chat_session_id.clone(),
        "collabSessionId": session.collab_session_id.clone(),
        "creatorMemberId": coordinator_member_id,
        "projectRef": session.project_ref.clone(),
        "messageCount": message_count,
        "createdAt": session.created_at,
        "updatedAt": session.updated_at,
        "lastMessageAt": session.last_message_at,
        "metadata": session.metadata.clone(),
        "chatSession": chat_session,
        "collabSession": collab_session
    })
}

pub(crate) fn create_or_attach_acp_session(
    store: &mut AppStore,
    payload: &Value,
    client: &AcpRequestClient,
) -> Result<AcpSessionRecord, AcpHttpError> {
    if chat_session_attach_requested(payload) {
        return Err(AcpHttpError::bad_request(
            "unsupported_attach_target",
            "ACP v1 rejects direct writes to normal chat/runtime sessions. Use an ACP session or attachTo.type=collab_session.",
        ));
    }

    if let Some(acp_session_id) = acp_session_id_from_payload(payload) {
        let session = store
            .acp_sessions
            .iter()
            .find(|item| item.id == acp_session_id)
            .cloned()
            .ok_or_else(|| {
                AcpHttpError::not_found("acp_session_not_found", "ACP session not found.")
            })?;
        ensure_acp_creator_member_id(store, &session.collab_session_id)?;
        repair_acp_source_title_if_needed(store, &session, client, payload)?;
        return Ok(store
            .acp_sessions
            .iter()
            .find(|item| item.id == acp_session_id)
            .cloned()
            .unwrap_or(session));
    }

    if let Some(collab_session_id) = collab_session_id_from_payload(payload) {
        if let Some(existing) = store
            .acp_sessions
            .iter()
            .find(|item| item.collab_session_id == collab_session_id)
            .cloned()
        {
            ensure_acp_creator_member_id(store, &existing.collab_session_id)?;
            return Ok(existing);
        }
        let collab = store
            .collab_sessions
            .iter()
            .find(|item| item.id == collab_session_id)
            .cloned()
            .ok_or_else(|| {
                AcpHttpError::not_found(
                    "collab_session_not_found",
                    "Collaboration session not found.",
                )
            })?;
        let acp_id = make_acp_id("acp-session");
        let title = payload_string(payload, "title").unwrap_or_else(|| collab.title.clone());
        let objective =
            payload_string(payload, "objective").unwrap_or_else(|| collab.objective.clone());
        let project_ref = project_ref_from_payload(payload);
        let chat_session_id = if let Some(owner) = collab.owner_session_id.clone() {
            owner
        } else {
            create_session(store, title.clone(), None).id
        };
        let session_metadata =
            acp_payload_metadata_with_scope(store, payload, collab.metadata.as_ref());
        let metadata = acp_chat_metadata(
            store,
            &acp_id,
            &collab_session_id,
            client,
            project_ref.clone(),
            Some(session_metadata.clone()),
        );
        update_chat_session_metadata(store, &chat_session_id, metadata)?;
        let session = create_acp_session_record(
            acp_id,
            collab_session_id,
            chat_session_id,
            client,
            payload,
            title,
            objective,
            project_ref,
            session_metadata,
        );
        store.acp_sessions.push(session.clone());
        let creator_member_id = ensure_acp_creator_member_id(store, &session.collab_session_id)?;
        append_acp_audit_event(
            store,
            Some(session.id.clone()),
            None,
            "acp.session.created",
            "ok",
            Some("ACP session attached to collaboration session.".to_string()),
            Some(json!({
                "collabSessionId": session.collab_session_id.clone(),
                "creatorMemberId": creator_member_id
            })),
        );
        return Ok(session);
    }

    let acp_id = make_acp_id("acp-session");
    let title = acp_prompt_title_from_payload(payload)
        .or_else(|| payload_string(payload, "title"))
        .unwrap_or_else(|| "External Agent Conversation".to_string());
    let objective = payload_string(payload, "objective")
        .or_else(|| prompt_from_payload(payload))
        .unwrap_or_else(|| "Work with RedBox Creator Agent through ACP.".to_string());
    let project_ref = project_ref_from_payload(payload);
    let chat_session = create_session(store, title.clone(), None);
    let session_metadata = acp_payload_metadata_with_scope(store, payload, None);
    let mut collab_metadata = value_object(Some(session_metadata.clone()));
    collab_metadata.insert("source".to_string(), json!("acp"));
    collab_metadata.insert("sourceLabel".to_string(), json!(client.source_label()));
    collab_metadata.insert("externalClientId".to_string(), json!(client.id.clone()));
    collab_metadata.insert("externalClientName".to_string(), json!(client.name.clone()));
    collab_metadata.insert("externalClientKind".to_string(), json!(client.kind.clone()));
    collab_metadata.insert("acpSessionId".to_string(), json!(acp_id.clone()));
    collab_metadata.insert("projectRef".to_string(), json!(project_ref.clone()));
    let collab = create_collab_session(
        store,
        &json!({
            "title": title.clone(),
            "objective": objective.clone(),
            "ownerSessionId": chat_session.id.clone(),
            "runtimeMode": payload_string(payload, "runtimeMode")
                .unwrap_or_else(|| store.acp_gateway.default_runtime_mode.clone()),
            "source": "acp",
            "metadata": Value::Object(collab_metadata)
        }),
    )
    .map_err(AcpHttpError::internal)?;
    let metadata = acp_chat_metadata(
        store,
        &acp_id,
        &collab.id,
        client,
        project_ref.clone(),
        Some(session_metadata.clone()),
    );
    update_chat_session_metadata(store, &chat_session.id, metadata)?;
    let session = create_acp_session_record(
        acp_id,
        collab.id,
        chat_session.id,
        client,
        payload,
        title,
        objective,
        project_ref,
        session_metadata,
    );
    store.acp_sessions.push(session.clone());
    let creator_member_id = ensure_acp_creator_member_id(store, &session.collab_session_id)?;
    append_acp_audit_event(
        store,
        Some(session.id.clone()),
        None,
        "acp.session.created",
        "ok",
        Some("ACP session auto-created.".to_string()),
        Some(json!({
            "chatSessionId": session.chat_session_id.clone(),
            "collabSessionId": session.collab_session_id.clone(),
            "creatorMemberId": creator_member_id
        })),
    );
    Ok(session)
}

pub(crate) fn append_inbound_message(
    store: &mut AppStore,
    session_id: &str,
    payload: &Value,
    client: &AcpRequestClient,
    run_id: Option<String>,
) -> Result<AcpMessageRecord, AcpHttpError> {
    let session = store
        .acp_sessions
        .iter()
        .find(|item| item.id == session_id)
        .cloned()
        .ok_or_else(|| {
            AcpHttpError::not_found("acp_session_not_found", "ACP session not found.")
        })?;
    let content = prompt_from_payload(payload).ok_or_else(|| {
        AcpHttpError::bad_request("missing_message_content", "Missing message content.")
    })?;
    let message_content = content.clone();
    let now = crate::now_i64();
    let chat_message_id = make_acp_id("message");
    let acp_message_id = make_acp_id("acp-message");
    let metadata = json!({
        "source": "acp",
        "senderKind": "external_agent",
        "senderLabel": client.name.clone(),
        "sourceLabel": client.source_label(),
        "externalClientId": client.id.clone(),
        "externalClientName": client.name.clone(),
        "externalClientKind": client.kind.clone(),
        "acpSessionId": session.id.clone(),
        "acpMessageId": acp_message_id,
        "acpRunId": run_id.clone(),
        "collabSessionId": session.collab_session_id.clone()
    });
    store.chat_messages.push(ChatMessageRecord {
        id: chat_message_id.clone(),
        session_id: session.chat_session_id.clone(),
        role: "user".to_string(),
        content: content.clone(),
        display_content: Some(content.clone()),
        attachment: payload.get("attachment").cloned(),
        metadata: Some(metadata.clone()),
        created_at: crate::now_iso(),
    });
    append_session_transcript(
        store,
        &session.chat_session_id,
        "message",
        "user",
        content.clone(),
        Some(json!({
            "runtimeMode": payload_string(payload, "runtimeMode")
                .unwrap_or_else(|| store.acp_gateway.default_runtime_mode.clone()),
            "metadata": metadata
        })),
    );
    let creator_member_id = ensure_acp_creator_member_id(store, &session.collab_session_id)?;
    let collab_message = post_collab_message(
        store,
        &json!({
            "sessionId": session.collab_session_id.clone(),
            "fromKind": "external_agent",
            "toMemberId": creator_member_id.clone(),
            "kind": "message",
            "messageType": "acp.external_message",
            "status": "unread",
            "subject": payload_string(payload, "subject"),
            "body": content.clone(),
            "attachmentRefs": payload_array_strings(payload, "attachmentRefs"),
            "payload": {
                "source": "acp",
                "sourceLabel": client.source_label(),
                "externalClientId": client.id.clone(),
                "externalClientName": client.name.clone(),
                "externalClientKind": client.kind.clone(),
                "acpSessionId": session.id.clone(),
                "acpRunId": run_id.clone(),
                "creatorMemberId": creator_member_id
            }
        }),
    )
    .map_err(AcpHttpError::internal)?;
    if let Some(chat_session) = store
        .chat_sessions
        .iter_mut()
        .find(|item| item.id == session.chat_session_id)
    {
        chat_session.updated_at = crate::now_iso();
    }
    if let Some(acp_session) = store
        .acp_sessions
        .iter_mut()
        .find(|item| item.id == session.id)
    {
        acp_session.updated_at = now;
        acp_session.last_message_at = Some(now);
    }
    let message = AcpMessageRecord {
        id: acp_message_id,
        session_id: session.id.clone(),
        run_id,
        direction: "inbound".to_string(),
        role: "user".to_string(),
        sender_kind: "external_agent".to_string(),
        sender_label: client.name.clone(),
        content: message_content,
        content_type: payload_string(payload, "contentType")
            .unwrap_or_else(|| "text/plain".to_string()),
        attachment_refs: payload_array_strings(payload, "attachmentRefs"),
        payload: payload_object(payload, "payload"),
        chat_message_id: Some(chat_message_id),
        collab_message_id: Some(collab_message.id),
        created_at: now,
    };
    store.acp_messages.push(message.clone());
    append_acp_audit_event(
        store,
        Some(session.id),
        message.run_id.clone(),
        "acp.message.inbound",
        "ok",
        Some("External agent message stored.".to_string()),
        Some(json!({ "messageId": message.id })),
    );
    Ok(message)
}

pub(crate) fn client_for_http(
    store: &AppStore,
    payload: &Value,
    headers: &std::collections::HashMap<String, String>,
) -> AcpRequestClient {
    client_from_payload_and_headers(payload, headers, &store.acp_gateway.default_client_label)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn test_client() -> AcpRequestClient {
        AcpRequestClient {
            id: Some("codex-local".to_string()),
            name: "Codex".to_string(),
            kind: "coding_agent".to_string(),
        }
    }

    #[test]
    fn project_ref_attach_creates_acp_chat_and_collab_projection() {
        let mut store = crate::persistence::default_store();
        let payload = json!({
            "title": "Project brief",
            "objective": "Create a video plan",
            "attachTo": {
                "type": "project_ref",
                "id": "project-1",
                "name": "Launch project"
            }
        });

        let session = create_or_attach_acp_session(&mut store, &payload, &test_client()).unwrap();

        assert_eq!(session.project_ref.as_ref().unwrap()["id"], "project-1");
        assert!(store
            .chat_sessions
            .iter()
            .any(|item| item.id == session.chat_session_id
                && item
                    .metadata
                    .as_ref()
                    .and_then(|metadata| metadata.get("source"))
                    == Some(&json!("acp"))));
        assert!(store
            .collab_sessions
            .iter()
            .any(|item| item.id == session.collab_session_id
                && item.source == "acp"
                && item.coordinator_member_id.is_some()));
    }

    #[test]
    fn auto_created_acp_session_inherits_active_space_scope() {
        let mut store = crate::persistence::default_store();
        store.spaces[0].id = "space-a".to_string();
        store.spaces[0].name = "Space A".to_string();
        store.active_space_id = "space-a".to_string();
        let payload = json!({
            "title": "Project brief",
            "objective": "Create a scoped ACP session"
        });

        let session = create_or_attach_acp_session(&mut store, &payload, &test_client()).unwrap();
        let chat_session = store
            .chat_sessions
            .iter()
            .find(|item| item.id == session.chat_session_id)
            .unwrap();
        let collab_session = store
            .collab_sessions
            .iter()
            .find(|item| item.id == session.collab_session_id)
            .unwrap();

        assert_eq!(
            chat_session
                .metadata
                .as_ref()
                .and_then(|metadata| metadata.get("spaceId")),
            Some(&json!("space-a"))
        );
        assert_eq!(
            collab_session
                .metadata
                .as_ref()
                .and_then(|metadata| metadata.get("spaceId")),
            Some(&json!("space-a"))
        );
        assert_eq!(
            session
                .metadata
                .as_ref()
                .and_then(|metadata| metadata.get("scope"))
                .and_then(|scope| scope.get("spaceName")),
            Some(&json!("Space A"))
        );
    }

    #[test]
    fn collab_attach_inherits_collab_space_scope() {
        let mut store = crate::persistence::default_store();
        store.spaces[0].id = "space-a".to_string();
        store.spaces[0].name = "Space A".to_string();
        store.spaces.push(crate::SpaceRecord {
            id: "space-b".to_string(),
            name: "Space B".to_string(),
            created_at: "1".to_string(),
            updated_at: "1".to_string(),
        });
        store.active_space_id = "space-b".to_string();
        let collab = create_collab_session(
            &mut store,
            &json!({
                "title": "Scoped team",
                "objective": "Keep ACP attach scoped",
                "metadata": {
                    "spaceId": "space-a",
                    "spaceName": "Space A"
                }
            }),
        )
        .unwrap();
        let payload = json!({
            "title": "Attach to scoped team",
            "attachTo": {
                "type": "collab_session",
                "id": collab.id
            }
        });

        let session = create_or_attach_acp_session(&mut store, &payload, &test_client()).unwrap();

        assert_eq!(
            session
                .metadata
                .as_ref()
                .and_then(|metadata| metadata.get("spaceId")),
            Some(&json!("space-a"))
        );
        let chat_session = store
            .chat_sessions
            .iter()
            .find(|item| item.id == session.chat_session_id)
            .unwrap();
        assert_eq!(
            chat_session
                .metadata
                .as_ref()
                .and_then(|metadata| metadata.get("spaceId")),
            Some(&json!("space-a"))
        );
    }

    #[test]
    fn auto_created_acp_session_prefers_prompt_title_over_source_label() {
        let mut store = crate::persistence::default_store();
        let payload = json!({
            "title": "Codex 与 RedBox 对话",
            "prompt": "请帮我整理三条选题方向"
        });

        let session = create_or_attach_acp_session(&mut store, &payload, &test_client()).unwrap();

        assert_eq!(
            session.title,
            "请帮我整理三条选题方向"
                .chars()
                .take(15)
                .collect::<String>()
        );
        let chat_session = store
            .chat_sessions
            .iter()
            .find(|item| item.id == session.chat_session_id)
            .unwrap();
        assert_eq!(chat_session.title, session.title);
    }

    #[test]
    fn existing_acp_source_title_is_repaired_from_first_inbound_message() {
        let mut store = crate::persistence::default_store();
        let payload = json!({ "title": "Codex 与 RedBox 对话" });
        let session = create_or_attach_acp_session(&mut store, &payload, &test_client()).unwrap();
        append_inbound_message(
            &mut store,
            &session.id,
            &json!({ "prompt": "请创建三个稿件分类" }),
            &test_client(),
            None,
        )
        .unwrap();

        let repaired = create_or_attach_acp_session(
            &mut store,
            &json!({
                "sessionId": session.id,
                "prompt": "后续消息不应该覆盖第一条标题"
            }),
            &test_client(),
        )
        .unwrap();

        assert_eq!(repaired.title, "请创建三个稿件分类");
        let chat_session = store
            .chat_sessions
            .iter()
            .find(|item| item.id == repaired.chat_session_id)
            .unwrap();
        assert_eq!(chat_session.title, repaired.title);
    }

    #[test]
    fn direct_runtime_session_attach_is_rejected() {
        let mut store = crate::persistence::default_store();
        let payload = json!({
            "attachTo": {
                "type": "runtime_session",
                "id": "session-1"
            }
        });

        let error = create_or_attach_acp_session(&mut store, &payload, &test_client())
            .expect_err("normal runtime session attach should be rejected");

        assert_eq!(error.code, "unsupported_attach_target");
    }
}
