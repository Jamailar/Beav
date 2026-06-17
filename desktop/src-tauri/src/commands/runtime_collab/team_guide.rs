use super::*;
use crate::runtime::{
    add_collab_member, create_collab_session, create_collab_task, ensure_collab_session_coordinator,
};
use serde_json::Map;

fn payload_bool(payload: &Value, key: &str) -> bool {
    payload.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn confirmed_team_plan(payload: &Value) -> bool {
    payload_bool(payload, "userConfirmedTeamPlan")
        || payload
            .get("metadata")
            .map(|metadata| payload_bool(metadata, "userConfirmedTeamPlan"))
            .unwrap_or(false)
}

fn insert_if_present(map: &mut Map<String, Value>, payload: &Value, key: &str) {
    if let Some(value) = payload.get(key).filter(|value| !value.is_null()) {
        map.insert(key.to_string(), value.clone());
    }
}

pub fn guide_create_value(
    app: &AppHandle,
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    if !confirmed_team_plan(payload) {
        return Err("TEAM_PLAN_CONFIRMATION_REQUIRED: 创建 team 前必须先向用户列出团队成员和分工，并等待用户明确确认。确认后再调用本动作，并传入 userConfirmedTeamPlan=true。".to_string());
    }

    let (result, member_events, task_events, session_event) = with_store_mut(state, |store| {
        let summary = payload_string(payload, "summary")
            .or_else(|| payload_string(payload, "objective"))
            .or_else(|| payload_string(payload, "goal"))
            .unwrap_or_else(|| "协作任务".to_string());
        let name = payload_string(payload, "name")
            .or_else(|| payload_string(payload, "title"))
            .unwrap_or_else(|| {
                summary
                    .chars()
                    .take(48)
                    .collect::<String>()
                    .trim()
                    .to_string()
            });
        let auto_open = payload
            .get("autoOpen")
            .and_then(Value::as_bool)
            .unwrap_or(true);
        let mut metadata = payload
            .get("metadata")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        metadata.insert("surface".to_string(), json!("team"));
        metadata.insert("autoOpen".to_string(), json!(auto_open));
        metadata.insert("source".to_string(), json!("team_guide"));
        metadata.insert("userConfirmedTeamPlan".to_string(), json!(true));

        let mut session_payload = Map::new();
        session_payload.insert("title".to_string(), json!(name));
        session_payload.insert("objective".to_string(), json!(summary));
        session_payload.insert("runtimeMode".to_string(), json!("team"));
        session_payload.insert("source".to_string(), json!("team-guide"));
        session_payload.insert("metadata".to_string(), Value::Object(metadata));
        insert_if_present(&mut session_payload, payload, "ownerSessionId");
        insert_if_present(&mut session_payload, payload, "workspaceRoot");

        let session = create_collab_session(store, &Value::Object(session_payload))?;
        let (session, coordinator, coordinator_created) =
            ensure_collab_session_coordinator(store, &session.id)?;

        let mut member_events = Vec::new();
        if coordinator_created {
            member_events.push(json!({
                "collabSessionId": coordinator.session_id,
                "member": coordinator
            }));
        }

        let mut role_to_member_id = Map::new();
        let mut created_members = Vec::new();
        for (index, member_input) in payload
            .get("members")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .enumerate()
        {
            let display_name = payload_string(&member_input, "displayName")
                .or_else(|| payload_string(&member_input, "name"));
            let Some(display_name) = display_name else {
                continue;
            };
            let role_id = payload_string(&member_input, "roleId")
                .unwrap_or_else(|| format!("member-{}", index + 1));
            let mut member_metadata = member_input
                .get("metadata")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            if let Some(responsibility) = payload_string(&member_input, "responsibility")
                .or_else(|| payload_string(&member_input, "role"))
            {
                member_metadata.insert("responsibility".to_string(), json!(responsibility));
            }
            if let Some(deliverable) = payload_string(&member_input, "deliverable") {
                member_metadata.insert("deliverable".to_string(), json!(deliverable));
            }
            member_metadata.insert("source".to_string(), json!("team_guide"));
            let member = add_collab_member(
                store,
                &json!({
                    "sessionId": session.id,
                    "displayName": display_name,
                    "roleId": role_id,
                    "capabilities": member_input.get("capabilities").cloned().unwrap_or_else(|| json!([])),
                    "metadata": Value::Object(member_metadata),
                    "sourceKind": "team_guide",
                    "backend": "redbox-runtime",
                    "adapterKind": "internal",
                    "status": "idle"
                }),
            )?;
            role_to_member_id.insert(member.role_id.clone(), json!(member.id.clone()));
            role_to_member_id.insert(member.display_name.clone(), json!(member.id.clone()));
            member_events.push(json!({
                "collabSessionId": member.session_id,
                "member": member
            }));
            created_members.push(member);
        }

        let mut task_events = Vec::new();
        let mut created_tasks = Vec::new();
        let mut unassigned_task_count = 0usize;
        for task_input in payload
            .get("tasks")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
        {
            let title = payload_string(&task_input, "title");
            let objective = payload_string(&task_input, "objective")
                .or_else(|| payload_string(&task_input, "description"))
                .or_else(|| title.clone())
                .unwrap_or_else(|| "执行协作任务".to_string());
            let mut task_payload = Map::new();
            task_payload.insert("sessionId".to_string(), json!(session.id));
            if let Some(title) = title {
                task_payload.insert("title".to_string(), json!(title));
            }
            task_payload.insert("objective".to_string(), json!(objective));
            insert_if_present(&mut task_payload, &task_input, "description");
            insert_if_present(&mut task_payload, &task_input, "priority");
            insert_if_present(&mut task_payload, &task_input, "dependsOnTaskIds");

            let member_id = payload_string(&task_input, "memberId").or_else(|| {
                payload_string(&task_input, "memberRoleId")
                    .or_else(|| payload_string(&task_input, "roleId"))
                    .or_else(|| payload_string(&task_input, "memberName"))
                    .or_else(|| payload_string(&task_input, "assignee"))
                    .and_then(|key| {
                        role_to_member_id
                            .get(&key)
                            .and_then(Value::as_str)
                            .map(ToString::to_string)
                    })
            });
            if let Some(member_id) = member_id {
                task_payload.insert("memberId".to_string(), json!(member_id));
            } else {
                unassigned_task_count += 1;
            }
            let mut task_metadata = task_input
                .get("metadata")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            if let Some(expected_output) = payload_string(&task_input, "expectedOutput") {
                task_metadata.insert("expectedOutput".to_string(), json!(expected_output));
            }
            task_metadata.insert("source".to_string(), json!("team_guide"));
            task_payload.insert("metadata".to_string(), Value::Object(task_metadata));
            let task = create_collab_task(store, &Value::Object(task_payload))?;
            task_events.push(json!({
                "collabSessionId": task.session_id,
                "task": task
            }));
            created_tasks.push(task);
        }

        let result = json!({
            "sessionId": session.id,
            "name": session.title,
            "memberCount": created_members.len(),
            "taskCount": created_tasks.len(),
            "unassignedTaskCount": unassigned_task_count,
            "route": {
                "view": "redclaw",
                "redclawAction": "open-team",
                "teamSessionId": session.id
            },
            "nextStep": "Team room opened automatically. End your turn now."
        });
        let session_event = json!({
            "collabSessionId": session.id,
            "session": session
        });

        Ok((result, member_events, task_events, session_event))
    })?;

    for payload in member_events {
        emit_collab_event(app, "runtime:collab-member-changed", None, payload);
    }
    for payload in task_events {
        emit_collab_event(app, "runtime:collab-task-changed", None, payload);
    }
    emit_collab_event(app, "runtime:collab-session-changed", None, session_event);

    Ok(result)
}
