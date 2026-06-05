use super::*;
use crate::runtime::{list_collab_members, list_collab_tasks};
use serde_json::Map;

fn team_wake_key(session_id: &str, member_id: &str) -> String {
    format!("{session_id}:{member_id}")
}

fn mark_team_member_wake_active(
    state: &State<'_, AppState>,
    session_id: &str,
    member_id: &str,
) -> bool {
    let Ok(mut active) = state.active_team_member_wakes.lock() else {
        return false;
    };
    active.insert(team_wake_key(session_id, member_id))
}

fn clear_team_member_wake_active(state: &State<'_, AppState>, session_id: &str, member_id: &str) {
    if let Ok(mut active) = state.active_team_member_wakes.lock() {
        active.remove(&team_wake_key(session_id, member_id));
    }
}

fn member_metadata_object(member: &CollabMemberRecord) -> Map<String, Value> {
    member
        .metadata
        .as_ref()
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default()
}

pub(super) fn team_member_session_metadata(
    store: &crate::AppStore,
    session: &CollabSessionRecord,
    member: &CollabMemberRecord,
) -> Value {
    let member_metadata = member_metadata_object(member);
    let advisor_id = member_metadata
        .get("advisorId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string);
    let advisor = advisor_id
        .as_ref()
        .and_then(|id| store.advisors.iter().find(|item| item.id == *id));

    let mut active_speaker = Map::new();
    active_speaker.insert("type".to_string(), json!("member"));
    active_speaker.insert("memberId".to_string(), json!(member.id));
    active_speaker.insert("displayName".to_string(), json!(member.display_name));
    active_speaker.insert("roleId".to_string(), json!(member.role_id));
    if let Some(advisor_id) = advisor_id.as_ref() {
        active_speaker.insert("speakerId".to_string(), json!(advisor_id));
        active_speaker.insert("memberId".to_string(), json!(advisor_id));
        active_speaker.insert("advisorId".to_string(), json!(advisor_id));
        active_speaker.insert("collabMemberId".to_string(), json!(member.id));
        active_speaker.insert(
            "knowledgeScope".to_string(),
            json!({
                "type": "advisor",
                "advisorId": advisor_id,
            }),
        );
    }
    if let Some(value) = member_metadata
        .get("avatar")
        .cloned()
        .or_else(|| advisor.map(|item| json!(item.avatar)))
    {
        active_speaker.insert("avatar".to_string(), value);
    }
    if let Some(value) = member_metadata
        .get("personality")
        .cloned()
        .or_else(|| advisor.map(|item| json!(item.personality)))
    {
        active_speaker.insert("personality".to_string(), value);
    }
    if let Some(value) = member_metadata
        .get("systemPrompt")
        .cloned()
        .or_else(|| advisor.map(|item| json!(item.system_prompt)))
    {
        active_speaker.insert("systemPrompt".to_string(), value);
    }

    let member_skill_ref = member_metadata
        .get("memberSkillRef")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .or_else(|| advisor.and_then(|item| item.member_skill_ref.clone()));

    let mut metadata = Map::new();
    metadata.insert("contextType".to_string(), json!("team"));
    metadata.insert("contextId".to_string(), json!(session.id));
    metadata.insert("runtimeMode".to_string(), json!("team"));
    metadata.insert("collabSessionId".to_string(), json!(session.id));
    metadata.insert("collabMemberId".to_string(), json!(member.id));
    metadata.insert("teamSessionTitle".to_string(), json!(session.title));
    metadata.insert("teamObjective".to_string(), json!(session.objective));
    metadata.insert("memberMentionMode".to_string(), json!(true));
    if let Some(advisor_id) = advisor_id.as_ref() {
        metadata.insert("advisorId".to_string(), json!(advisor_id));
        metadata.insert(
            "memberMentionAdvisorName".to_string(),
            json!(member.display_name),
        );
    }
    metadata.insert("activeSpeaker".to_string(), Value::Object(active_speaker));
    if let Some(member_skill_ref) = member_skill_ref {
        metadata.insert(
            "activeSkills".to_string(),
            json!([member_skill_ref.clone()]),
        );
        metadata.insert("memberSkillRef".to_string(), json!(member_skill_ref));
    }
    Value::Object(metadata)
}

fn ensure_member_conversation_session(
    store: &mut crate::AppStore,
    session: &CollabSessionRecord,
    member: &CollabMemberRecord,
) -> String {
    if let Some(existing) = member
        .conversation_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return existing.to_string();
    }

    let metadata = team_member_session_metadata(store, session, member);
    let chat_session = create_session(
        store,
        format!("{} / {}", session.title, member.display_name),
        Some(metadata),
    );
    chat_session.id
}

fn format_team_member_prompt(
    session: &CollabSessionRecord,
    member: &CollabMemberRecord,
    members: &[CollabMemberRecord],
    tasks: &[CollabTaskRecord],
    messages: &[CollabMailboxMessageRecord],
) -> String {
    let member_lines = members
        .iter()
        .map(|item| {
            format!(
                "- {} ({}, id={}, status={})",
                item.display_name, item.role_id, item.id, item.status
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    let task_lines = tasks
        .iter()
        .filter(|task| {
            task.member_id.as_deref() == Some(member.id.as_str()) || task.member_id.is_none()
        })
        .map(|task| {
            format!(
                "- [{}] {} | status={} | objective={}",
                task.id, task.title, task.status, task.objective
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    let message_lines = messages
        .iter()
        .map(|message| {
            let from = message
                .from_member_id
                .as_deref()
                .unwrap_or(message.from_kind.as_str());
            format!(
                "- from={} type={} subject={} body={}",
                from,
                message.message_type,
                message.subject.as_deref().unwrap_or(""),
                message.body
            )
        })
        .collect::<Vec<_>>()
        .join("\n");

    format!(
        "Team runtime wake.\n\nSession: {} ({})\nObjective: {}\n\nYou are: {} ({}, memberId={}).\n\nMembers:\n{}\n\nYour open work items:\n{}\n\nUnread mailbox messages:\n{}\n\nWork instructions:\n- Act only as this team member.\n- If you need to coordinate, use the available team actions/tools to update tasks, submit reports, or send mailbox messages.\n- Produce concrete work or a concrete status update. Keep the final answer concise because the host will save it as this member's progress report.\n- If blocked, say exactly what is blocking you and what should happen next.",
        session.title,
        session.id,
        session.objective,
        member.display_name,
        member.role_id,
        member.id,
        if member_lines.trim().is_empty() {
            "(none)"
        } else {
            &member_lines
        },
        if task_lines.trim().is_empty() {
            "(none)"
        } else {
            &task_lines
        },
        if message_lines.trim().is_empty() {
            "(none)"
        } else {
            &message_lines
        },
    )
}

struct TeamWakeInput {
    session: CollabSessionRecord,
    member: CollabMemberRecord,
    members: Vec<CollabMemberRecord>,
    tasks: Vec<CollabTaskRecord>,
    messages: Vec<CollabMailboxMessageRecord>,
    conversation_id: String,
}

fn prepare_team_member_wake(
    state: &State<'_, AppState>,
    session_id: &str,
    member_id: &str,
) -> Result<Option<TeamWakeInput>, String> {
    with_store_mut(state, |store| {
        let session = store
            .collab_sessions
            .iter()
            .find(|item| item.id == session_id)
            .cloned()
            .ok_or_else(|| "协作会话不存在".to_string())?;
        if matches!(
            session.status.as_str(),
            "paused" | "completed" | "failed" | "archived"
        ) {
            return Ok(None);
        }
        let member_index = store
            .collab_members
            .iter()
            .position(|item| item.session_id == session_id && item.id == member_id)
            .ok_or_else(|| "协作成员不存在".to_string())?;
        let member_snapshot = store.collab_members[member_index].clone();
        if matches!(
            member_snapshot.status.as_str(),
            "offline" | "suspended" | "archived" | "disabled" | "shutdown"
        ) {
            return Ok(None);
        }
        let now = now_i64();
        let mut messages = Vec::new();
        for message in store.collab_mailbox_messages.iter_mut() {
            if message.session_id == session_id
                && message.to_member_id.as_deref() == Some(member_id)
                && message.read_at.is_none()
            {
                message.read_at = Some(now);
                message.status = "read".to_string();
                messages.push(message.clone());
            }
        }
        if messages.is_empty() {
            return Ok(None);
        }
        let conversation_id = ensure_member_conversation_session(store, &session, &member_snapshot);
        let member = &mut store.collab_members[member_index];
        member.conversation_id = Some(conversation_id.clone());
        member.status = "active".to_string();
        member.last_seen_at = Some(now);
        member.last_activity_at = Some(now);
        member.last_error = None;
        member.updated_at = now;
        let member = member.clone();
        let members = list_collab_members(store, session_id);
        let tasks = list_collab_tasks(store, session_id);
        Ok(Some(TeamWakeInput {
            session,
            member,
            members,
            tasks,
            messages,
            conversation_id,
        }))
    })
}

fn team_member_is_settled(status: &str) -> bool {
    matches!(
        status,
        "idle" | "completed" | "failed" | "offline" | "suspended" | "archived" | "shutdown"
    )
}

pub(super) fn non_coordinator_members_settled(
    store: &crate::AppStore,
    session_id: &str,
    coordinator_id: &str,
) -> bool {
    store
        .collab_members
        .iter()
        .filter(|member| member.session_id == session_id && member.id != coordinator_id)
        .all(|member| team_member_is_settled(member.status.as_str()))
}

fn finish_team_member_wake(
    app: &AppHandle,
    state: &State<'_, AppState>,
    input: &TeamWakeInput,
    result: Result<String, String>,
) -> Result<(), String> {
    let (member, report, coordinator_message, coordinator_target) =
        with_store_mut(state, |store| {
            let now = now_i64();
            let (status, summary, blockers) = match result {
                Ok(response) => ("idle", response, Vec::<String>::new()),
                Err(error) => ("failed", error.clone(), vec![error]),
            };
            let mut member = store
                .collab_members
                .iter_mut()
                .find(|item| item.session_id == input.session.id && item.id == input.member.id)
                .cloned()
                .ok_or_else(|| "协作成员不存在".to_string())?;
            if let Some(target) = store
                .collab_members
                .iter_mut()
                .find(|item| item.session_id == input.session.id && item.id == input.member.id)
            {
                target.status = status.to_string();
                target.last_seen_at = Some(now);
                target.last_activity_at = Some(now);
                target.last_report_at = Some(now);
                target.last_error = if status == "failed" {
                    Some(summary.clone())
                } else {
                    None
                };
                target.updated_at = now;
                member = target.clone();
            }
            let report = submit_collab_report(
                store,
                &json!({
                    "sessionId": input.session.id,
                    "memberId": input.member.id,
                    "taskId": input.member.current_task_id,
                    "status": status,
                    "reportType": if status == "failed" { "failure" } else { "progress" },
                    "summary": summary,
                    "blockers": blockers,
                    "payload": {
                        "source": "team_member_wake",
                        "conversationId": input.conversation_id
                    }
                }),
            )?;
            let coordinator_id = store
                .collab_sessions
                .iter()
                .find(|item| item.id == input.session.id)
                .and_then(|item| item.coordinator_member_id.clone());
            let coordinator_message = if let Some(coordinator_id) = coordinator_id.as_deref() {
                if coordinator_id != input.member.id {
                    Some(post_collab_message(
                        store,
                        &json!({
                            "sessionId": input.session.id,
                            "fromMemberId": input.member.id,
                            "toMemberId": coordinator_id,
                            "fromKind": "member",
                            "messageType": "idle_notification",
                            "kind": "message",
                            "subject": format!("{} completed a turn", input.member.display_name),
                            "body": report.summary,
                            "payload": {
                                "source": "team_member_wake",
                                "reportId": report.id,
                                "status": status
                            }
                        }),
                    )?)
                } else {
                    None
                }
            } else {
                None
            };
            let coordinator_target = coordinator_id.as_deref().and_then(|coordinator_id| {
                if non_coordinator_members_settled(store, &input.session.id, coordinator_id) {
                    coordinator_message
                        .as_ref()
                        .and_then(|message| message.to_member_id.clone())
                } else {
                    None
                }
            });
            Ok((member, report, coordinator_message, coordinator_target))
        })?;

    emit_collab_event(
        app,
        "runtime:collab-member-changed",
        None,
        json!({ "collabSessionId": member.session_id, "member": member }),
    );
    emit_collab_event(
        app,
        "runtime:collab-report-submitted",
        None,
        json!({ "collabSessionId": report.session_id, "report": report }),
    );
    if let Some(message) = coordinator_message {
        emit_collab_event(
            app,
            "runtime:collab-message-delivered",
            None,
            json!({ "collabSessionId": message.session_id, "message": message }),
        );
    }
    if let Some(member_id) = coordinator_target {
        schedule_team_member_wake(
            app,
            state,
            input.session.id.clone(),
            member_id,
            "member_completed",
        );
    }
    Ok(())
}

fn run_team_member_wake(
    app: &AppHandle,
    state: &State<'_, AppState>,
    session_id: &str,
    member_id: &str,
) -> Result<(), String> {
    let Some(input) = prepare_team_member_wake(state, session_id, member_id)? else {
        return Ok(());
    };
    emit_collab_event(
        app,
        "runtime:collab-member-changed",
        None,
        json!({ "collabSessionId": input.member.session_id, "member": input.member }),
    );
    let prompt = format_team_member_prompt(
        &input.session,
        &input.member,
        &input.members,
        &input.tasks,
        &input.messages,
    );
    let turn = PreparedSessionAgentTurn::session_bridge(build_session_bridge_turn(
        input.conversation_id.clone(),
        prompt,
    ));
    let result =
        execute_prepared_session_agent_turn(Some(app), state, &turn).and_then(|execution| {
            emit_session_agent_completion(
                app,
                state,
                &execution,
                SessionAgentTurnKind::SessionBridge,
            )?;
            Ok(execution.response().to_string())
        });
    finish_team_member_wake(app, state, &input, result)
}

pub(super) fn schedule_team_member_wake(
    app: &AppHandle,
    state: &State<'_, AppState>,
    session_id: String,
    member_id: String,
    reason: &str,
) {
    if session_id.trim().is_empty() || member_id.trim().is_empty() {
        return;
    }
    if !mark_team_member_wake_active(state, &session_id, &member_id) {
        return;
    }
    emit_collab_event(
        app,
        "runtime:collab-member-wake-scheduled",
        None,
        json!({
            "collabSessionId": session_id,
            "memberId": member_id,
            "reason": reason,
        }),
    );
    let app_handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = app_handle.state::<AppState>();
        let result = run_team_member_wake(&app_handle, &state, &session_id, &member_id);
        clear_team_member_wake_active(&state, &session_id, &member_id);
        if has_pending_member_messages(&state, &session_id, &member_id) {
            schedule_team_member_wake(
                &app_handle,
                &state,
                session_id.clone(),
                member_id.clone(),
                "pending_mailbox",
            );
        }
        if let Err(error) = result {
            emit_collab_event(
                &app_handle,
                "runtime:collab-member-wake-failed",
                None,
                json!({
                    "collabSessionId": session_id,
                    "memberId": member_id,
                    "error": error,
                }),
            );
        }
    });
}

pub(super) fn schedule_message_target_wake(
    app: &AppHandle,
    state: &State<'_, AppState>,
    message: &CollabMailboxMessageRecord,
    reason: &str,
) {
    if let Some(member_id) = message.to_member_id.clone() {
        schedule_team_member_wake(app, state, message.session_id.clone(), member_id, reason);
    }
}

fn mailbox_messages_from_value(value: &Value) -> Vec<CollabMailboxMessageRecord> {
    if let Ok(message) = serde_json::from_value::<CollabMailboxMessageRecord>(value.clone()) {
        return vec![message];
    }
    value
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    serde_json::from_value::<CollabMailboxMessageRecord>(item.clone()).ok()
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

fn has_pending_member_messages(
    state: &State<'_, AppState>,
    session_id: &str,
    member_id: &str,
) -> bool {
    with_store(state, |store| {
        Ok(store.collab_mailbox_messages.iter().any(|message| {
            message.session_id == session_id
                && message.to_member_id.as_deref() == Some(member_id)
                && message.read_at.is_none()
        }))
    })
    .unwrap_or(false)
}

pub(super) fn emit_team_action_result_events(
    app: &AppHandle,
    state: &State<'_, AppState>,
    action: &str,
    value: &Value,
) {
    match action {
        "team.session.create" => {
            if let Ok(session) = serde_json::from_value::<CollabSessionRecord>(value.clone()) {
                emit_collab_event(
                    app,
                    "runtime:collab-session-created",
                    None,
                    json!({ "collabSessionId": session.id, "session": session }),
                );
            }
        }
        "team.member.add" | "team.member.rename" | "team.member.shutdown" => {
            if let Ok(member) = serde_json::from_value::<CollabMemberRecord>(value.clone()) {
                emit_collab_event(
                    app,
                    "runtime:collab-member-changed",
                    None,
                    json!({ "collabSessionId": member.session_id, "member": member }),
                );
            }
        }
        "team.task.create" | "team.task.update" | "team.task.transition" | "team.task.retry" => {
            if let Ok(task) = serde_json::from_value::<CollabTaskRecord>(value.clone()) {
                emit_collab_event(
                    app,
                    "runtime:collab-task-changed",
                    None,
                    json!({ "collabSessionId": task.session_id, "task": task }),
                );
            }
        }
        "team.message.post" | "team.report.request" => {
            for message in mailbox_messages_from_value(value) {
                emit_collab_event(
                    app,
                    "runtime:collab-message-delivered",
                    None,
                    json!({ "collabSessionId": message.session_id, "message": message }),
                );
                schedule_message_target_wake(app, state, &message, action);
            }
        }
        "team.report.submit" => {
            if let Ok(report) = serde_json::from_value::<CollabProgressReportRecord>(value.clone())
            {
                emit_collab_event(
                    app,
                    "runtime:collab-report-submitted",
                    None,
                    json!({ "collabSessionId": report.session_id, "report": report }),
                );
            }
        }
        _ => {}
    }
}
