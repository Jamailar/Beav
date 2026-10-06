use super::*;

pub fn list_collab_members(store: &AppStore, session_id: &str) -> Vec<CollabMemberRecord> {
    let mut members: Vec<CollabMemberRecord> = store
        .collab_members
        .iter()
        .filter(|member| member.session_id == session_id)
        .cloned()
        .collect();
    members.sort_by(|a, b| a.created_at.cmp(&b.created_at));
    members
}

pub fn add_collab_member(
    store: &mut AppStore,
    payload: &Value,
) -> Result<CollabMemberRecord, String> {
    let session_id =
        value_string(payload, "sessionId").ok_or_else(|| "缺少 sessionId".to_string())?;
    validate_session(store, &session_id)?;
    let now = now_i64();
    let member_id = next_collab_id("collab-member", |candidate| {
        store
            .collab_members
            .iter()
            .any(|member| member.id == candidate)
    });
    let display_name = value_string(payload, "displayName")
        .or_else(|| value_string(payload, "name"))
        .unwrap_or_else(|| "协作成员".to_string());
    let role_id = value_string(payload, "roleId").unwrap_or_else(|| "executor".to_string());
    let capabilities = value_string_array(payload, "capabilities");
    let allowed_tools = value_string_array(payload, "allowedTools");
    let member = CollabMemberRecord {
        id: member_id.clone(),
        session_id: session_id.clone(),
        display_name: display_name.clone(),
        role_id: role_id.clone(),
        source_kind: value_string(payload, "sourceKind")
            .or_else(|| value_string(payload, "adapterKind"))
            .unwrap_or_else(|| "internal_runtime".to_string()),
        backend: value_string(payload, "backend").unwrap_or_else(|| "redbox-runtime".to_string()),
        adapter_kind: value_string(payload, "adapterKind")
            .unwrap_or_else(|| "internal".to_string()),
        status: value_string(payload, "status").unwrap_or_else(|| "idle".to_string()),
        current_task_id: value_string(payload, "currentTaskId"),
        conversation_id: value_string(payload, "conversationId"),
        runtime_id: value_string(payload, "runtimeId"),
        capabilities: capabilities.clone(),
        allowed_tools: allowed_tools.clone(),
        desired_model_config: value_object(payload, "desiredModelConfig"),
        current_model_config: value_object(payload, "currentModelConfig"),
        progress_interval_ms: value_i64(payload, "progressIntervalMs")
            .filter(|value| *value > 0)
            .unwrap_or(DEFAULT_PROGRESS_INTERVAL_MS),
        report_interval_seconds: value_i64(payload, "reportIntervalSeconds")
            .filter(|value| *value > 0)
            .unwrap_or(DEFAULT_PROGRESS_INTERVAL_MS / 1000),
        last_seen_at: None,
        last_report_at: None,
        last_activity_at: None,
        last_error: None,
        metadata: member_metadata_from_payload(
            &member_id,
            &session_id,
            &display_name,
            &role_id,
            &capabilities,
            &allowed_tools,
            payload,
        ),
        created_at: now,
        updated_at: now,
    };
    store.collab_members.push(member.clone());
    touch_session(store, &session_id, now);
    Ok(member)
}

pub fn rename_collab_member(
    store: &mut AppStore,
    payload: &Value,
) -> Result<CollabMemberRecord, String> {
    let session_id =
        value_string(payload, "sessionId").ok_or_else(|| "缺少 sessionId".to_string())?;
    let member_id = value_string(payload, "memberId").ok_or_else(|| "缺少 memberId".to_string())?;
    validate_session(store, &session_id)?;
    let now = now_i64();
    let member = store
        .collab_members
        .iter_mut()
        .find(|member| member.session_id == session_id && member.id == member_id)
        .ok_or_else(|| "协作成员不存在或不属于该会话".to_string())?;
    if let Some(display_name) =
        value_string(payload, "displayName").or_else(|| value_string(payload, "name"))
    {
        member.display_name = display_name.clone();
        if let Some(agent_card) = member
            .metadata
            .as_mut()
            .and_then(Value::as_object_mut)
            .and_then(|metadata| metadata.get_mut("agentCard"))
            .and_then(Value::as_object_mut)
        {
            agent_card.insert("displayName".to_string(), json!(display_name));
        }
    }
    if let Some(role_id) = value_string(payload, "roleId") {
        member.role_id = role_id.clone();
        if let Some(agent_card) = member
            .metadata
            .as_mut()
            .and_then(Value::as_object_mut)
            .and_then(|metadata| metadata.get_mut("agentCard"))
            .and_then(Value::as_object_mut)
        {
            agent_card.insert("roleId".to_string(), json!(role_id));
        }
    }
    member.updated_at = now;
    let updated = member.clone();
    touch_session(store, &session_id, now);
    Ok(updated)
}

pub fn shutdown_collab_member(
    store: &mut AppStore,
    payload: &Value,
) -> Result<CollabMemberRecord, String> {
    let session_id =
        value_string(payload, "sessionId").ok_or_else(|| "缺少 sessionId".to_string())?;
    let member_id = value_string(payload, "memberId").ok_or_else(|| "缺少 memberId".to_string())?;
    validate_session(store, &session_id)?;
    let now = now_i64();
    let member = store
        .collab_members
        .iter_mut()
        .find(|member| member.session_id == session_id && member.id == member_id)
        .ok_or_else(|| "协作成员不存在或不属于该会话".to_string())?;
    member.status = value_string(payload, "status").unwrap_or_else(|| "offline".to_string());
    member.current_task_id = None;
    member.last_error = value_string(payload, "reason");
    member.updated_at = now;
    member.last_activity_at = Some(now);
    let mut metadata = member
        .metadata
        .take()
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    metadata.insert(
        "shutdown".to_string(),
        json!({
            "at": now,
            "reason": value_string(payload, "reason")
        }),
    );
    member.metadata = Some(Value::Object(metadata));
    let updated = member.clone();
    touch_session(store, &session_id, now);
    Ok(updated)
}

pub fn resume_collab_member(
    store: &mut AppStore,
    payload: &Value,
) -> Result<CollabMemberRecord, String> {
    let session_id =
        value_string(payload, "sessionId").ok_or_else(|| "缺少 sessionId".to_string())?;
    let member_id = value_string(payload, "memberId").ok_or_else(|| "缺少 memberId".to_string())?;
    validate_session(store, &session_id)?;
    let now = now_i64();
    let member = store
        .collab_members
        .iter_mut()
        .find(|member| member.session_id == session_id && member.id == member_id)
        .ok_or_else(|| "协作成员不存在或不属于该会话".to_string())?;
    member.status = value_string(payload, "status").unwrap_or_else(|| "idle".to_string());
    member.last_error = None;
    member.updated_at = now;
    member.last_activity_at = Some(now);
    let mut metadata = member
        .metadata
        .take()
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    metadata.insert(
        "resume".to_string(),
        json!({
            "at": now,
            "reason": value_string(payload, "reason")
        }),
    );
    member.metadata = Some(Value::Object(metadata));
    let updated = member.clone();
    touch_session(store, &session_id, now);
    Ok(updated)
}
