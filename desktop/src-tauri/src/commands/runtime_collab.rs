use serde_json::{json, Map, Value};
use tauri::{AppHandle, State};

use crate::commands::redclaw::redclaw_task_control;
use crate::events::emit_runtime_event;
use crate::persistence::{with_store, with_store_mut};
use crate::runtime::{
    add_collab_member, archive_review_docket, collab_session_snapshot, create_collab_session,
    create_collab_task, create_review_docket, decide_review_docket,
    ensure_collab_session_coordinator, get_review_docket, list_collab_members,
    list_collab_messages, list_collab_reports, list_collab_sessions, list_collab_tasks,
    list_review_dockets, pin_collab_task_session, post_collab_message, read_collab_mailbox,
    rename_collab_member, request_collab_report, retry_collab_task, review_docket_stats,
    set_collab_session_coordinator, shutdown_collab_member, submit_collab_report,
    transition_collab_task, update_collab_session_status, update_collab_task, ReviewDocketRecord,
};
use crate::subagents::{execute_team_tool, team_tool_descriptors, tick_team_wake_runtime};
use crate::{parse_timestamp_ms, payload_string, AppState};

#[derive(Debug, Clone)]
struct ApprovalActionRouteResult {
    kind: String,
    status: &'static str,
    message: Option<String>,
}

impl ApprovalActionRouteResult {
    fn json(&self) -> Value {
        json!({
            "kind": self.kind,
            "status": self.status,
            "message": self.message,
        })
    }
}

fn payload_limit(payload: &Value, key: &str) -> Option<usize> {
    payload
        .get(key)
        .and_then(Value::as_u64)
        .filter(|value| *value > 0)
        .map(|value| value as usize)
}

fn emit_collab_event(
    app: &AppHandle,
    event_type: &str,
    owner_session_id: Option<&str>,
    payload: Value,
) {
    emit_runtime_event(app, event_type, owner_session_id, None, payload);
}

pub fn list_sessions_value(state: &State<'_, AppState>) -> Result<Value, String> {
    with_store(state, |store| Ok(json!(list_collab_sessions(&store))))
}

pub fn create_session_value(
    app: &AppHandle,
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let (session, coordinator) = with_store_mut(state, |store| {
        let session = create_collab_session(store, payload)?;
        let runtime_mode = session.runtime_mode.trim().to_ascii_lowercase();
        let source = session.source.trim().to_ascii_lowercase();
        if runtime_mode == "team" || source == "team-workbench" {
            let (session, member, created) = ensure_collab_session_coordinator(store, &session.id)?;
            Ok((session, created.then_some(member)))
        } else {
            Ok((session, None))
        }
    })?;
    if let Some(member) = coordinator {
        emit_collab_event(
            app,
            "runtime:collab-member-changed",
            None,
            json!({ "collabSessionId": member.session_id, "member": member }),
        );
    }
    emit_collab_event(
        app,
        "runtime:collab-session-changed",
        session.owner_session_id.as_deref(),
        json!({ "collabSessionId": session.id, "session": session }),
    );
    Ok(json!(session))
}

pub fn session_snapshot_value(
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let session_id =
        payload_string(payload, "sessionId").ok_or_else(|| "缺少 sessionId".to_string())?;
    let mailbox_limit = payload_limit(payload, "mailboxLimit");
    let report_limit = payload_limit(payload, "reportLimit");
    with_store(state, |store| {
        collab_session_snapshot(&store, &session_id, mailbox_limit, report_limit)
            .map(|snapshot| json!(snapshot))
            .ok_or_else(|| "协作会话不存在".to_string())
    })
}

pub fn list_members_value(state: &State<'_, AppState>, payload: &Value) -> Result<Value, String> {
    let session_id =
        payload_string(payload, "sessionId").ok_or_else(|| "缺少 sessionId".to_string())?;
    with_store(state, |store| {
        Ok(json!(list_collab_members(&store, &session_id)))
    })
}

pub fn list_tasks_value(state: &State<'_, AppState>, payload: &Value) -> Result<Value, String> {
    let session_id =
        payload_string(payload, "sessionId").ok_or_else(|| "缺少 sessionId".to_string())?;
    with_store(state, |store| {
        Ok(json!(list_collab_tasks(&store, &session_id)))
    })
}

pub fn list_messages_value(state: &State<'_, AppState>, payload: &Value) -> Result<Value, String> {
    let session_id =
        payload_string(payload, "sessionId").ok_or_else(|| "缺少 sessionId".to_string())?;
    let member_id = payload_string(payload, "memberId");
    let task_id = payload_string(payload, "taskId");
    let unread_only = payload
        .get("unreadOnly")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let limit = payload_limit(payload, "limit");
    with_store(state, |store| {
        Ok(json!(list_collab_messages(
            &store,
            &session_id,
            member_id.as_deref(),
            task_id.as_deref(),
            unread_only,
            limit,
        )))
    })
}

pub fn read_mailbox_value(state: &State<'_, AppState>, payload: &Value) -> Result<Value, String> {
    with_store_mut(state, |store| {
        Ok(json!(read_collab_mailbox(store, payload)?))
    })
}

pub fn list_reports_value(state: &State<'_, AppState>, payload: &Value) -> Result<Value, String> {
    let session_id =
        payload_string(payload, "sessionId").ok_or_else(|| "缺少 sessionId".to_string())?;
    let task_id = payload_string(payload, "taskId");
    let member_id = payload_string(payload, "memberId");
    let limit = payload_limit(payload, "limit");
    with_store(state, |store| {
        Ok(json!(list_collab_reports(
            &store,
            &session_id,
            task_id.as_deref(),
            member_id.as_deref(),
            limit,
        )))
    })
}

pub fn add_member_value(
    app: &AppHandle,
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let member = with_store_mut(state, |store| add_collab_member(store, payload))?;
    emit_collab_event(
        app,
        "runtime:collab-member-changed",
        None,
        json!({ "collabSessionId": member.session_id, "member": member }),
    );
    Ok(json!(member))
}

pub fn set_session_coordinator_value(
    app: &AppHandle,
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let session = with_store_mut(state, |store| {
        set_collab_session_coordinator(store, payload)
    })?;
    emit_collab_event(
        app,
        "runtime:collab-session-changed",
        session.owner_session_id.as_deref(),
        json!({ "collabSessionId": session.id, "session": session }),
    );
    Ok(json!(session))
}

pub fn rename_member_value(
    app: &AppHandle,
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let member = with_store_mut(state, |store| rename_collab_member(store, payload))?;
    emit_collab_event(
        app,
        "runtime:collab-member-changed",
        None,
        json!({ "collabSessionId": member.session_id, "member": member }),
    );
    Ok(json!(member))
}

pub fn shutdown_member_value(
    app: &AppHandle,
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let member = with_store_mut(state, |store| shutdown_collab_member(store, payload))?;
    emit_collab_event(
        app,
        "runtime:collab-member-changed",
        None,
        json!({ "collabSessionId": member.session_id, "member": member }),
    );
    Ok(json!(member))
}

pub fn create_task_value(
    app: &AppHandle,
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let task = with_store_mut(state, |store| create_collab_task(store, payload))?;
    emit_collab_event(
        app,
        "runtime:collab-task-changed",
        None,
        json!({ "collabSessionId": task.session_id, "task": task }),
    );
    Ok(json!(task))
}

pub fn update_task_value(
    app: &AppHandle,
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let task = with_store_mut(state, |store| update_collab_task(store, payload))?;
    emit_collab_event(
        app,
        "runtime:collab-task-changed",
        None,
        json!({ "collabSessionId": task.session_id, "task": task }),
    );
    Ok(json!(task))
}

pub fn transition_task_value(
    app: &AppHandle,
    state: &State<'_, AppState>,
    payload: &Value,
    transition: &str,
) -> Result<Value, String> {
    let task = with_store_mut(state, |store| {
        transition_collab_task(store, payload, transition)
    })?;
    emit_collab_event(
        app,
        "runtime:collab-task-changed",
        None,
        json!({ "collabSessionId": task.session_id, "task": task, "transition": transition }),
    );
    Ok(json!(task))
}

pub fn pin_task_session_value(
    app: &AppHandle,
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let task = with_store_mut(state, |store| pin_collab_task_session(store, payload))?;
    emit_collab_event(
        app,
        "runtime:collab-task-changed",
        None,
        json!({ "collabSessionId": task.session_id, "task": task, "transition": "pin-session" }),
    );
    Ok(json!(task))
}

pub fn retry_task_value(
    app: &AppHandle,
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let task = with_store_mut(state, |store| retry_collab_task(store, payload))?;
    emit_collab_event(
        app,
        "runtime:collab-task-changed",
        None,
        json!({ "collabSessionId": task.session_id, "task": task, "transition": "retry" }),
    );
    Ok(json!(task))
}

pub fn list_review_dockets_value(
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    with_store(state, |store| {
        Ok(json!(list_review_dockets(&store, payload)))
    })
}

pub fn get_review_docket_value(
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let docket_id =
        payload_string(payload, "docketId").ok_or_else(|| "缺少 docketId".to_string())?;
    with_store(state, |store| {
        get_review_docket(&store, &docket_id)
            .map(|docket| json!(docket))
            .ok_or_else(|| "审批项不存在".to_string())
    })
}

pub fn review_docket_stats_value(state: &State<'_, AppState>) -> Result<Value, String> {
    with_store(state, |store| Ok(review_docket_stats(&store)))
}

fn redclaw_definition_status(
    definition: &crate::runtime::RedclawJobDefinitionRecord,
    latest_status: Option<&str>,
) -> &'static str {
    let cooldown_active = definition
        .payload
        .get("cooldown")
        .and_then(Value::as_object)
        .and_then(|cooldown| cooldown.get("state"))
        .and_then(Value::as_str)
        == Some("active");
    if definition.requires_confirmation {
        return "queued";
    }
    if cooldown_active {
        return "blocked";
    }
    match latest_status.unwrap_or_default() {
        "running" | "leased" | "retrying" => "running",
        "failed" | "dead_lettered" => "failed",
        "completed" | "succeeded" => "completed",
        _ if !definition.enabled => "paused",
        _ => "queued",
    }
}

fn collab_panel_status(status: &str) -> &'static str {
    match status {
        "in_progress" | "active" | "working" | "running" => "running",
        "waiting_for_review" | "reviewing" | "review" => "review",
        "blocked" => "blocked",
        "done" | "completed" => "completed",
        "failed" | "cancelled" => "failed",
        "paused" | "archived" => "paused",
        _ => "queued",
    }
}

fn docket_panel_status(status: &str) -> &'static str {
    match status {
        "approved" => "completed",
        "rejected" => "failed",
        "changes_requested" => "blocked",
        "skipped" | "archived" => "paused",
        _ => "review",
    }
}

fn panel_status_rank(status: &str) -> i32 {
    match status {
        "review" => 0,
        "blocked" => 1,
        "running" => 2,
        "queued" => 3,
        "failed" => 4,
        "paused" => 5,
        "completed" => 6,
        _ => 9,
    }
}

fn redclaw_task_content(definition: &crate::runtime::RedclawJobDefinitionRecord) -> String {
    ["goal", "prompt", "objective", "stepPrompt"]
        .iter()
        .filter_map(|key| definition.payload.get(*key).and_then(Value::as_str))
        .map(str::trim)
        .find(|value| !value.is_empty())
        .unwrap_or("当前任务没有附带说明内容。")
        .to_string()
}

fn json_i64(value: &Value, key: &str) -> Option<i64> {
    value.get(key).and_then(Value::as_i64)
}

fn item_updated_at(item: &Value) -> i64 {
    item.get("updatedAt").and_then(Value::as_i64).unwrap_or(0)
}

pub fn task_panel_list_value(
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let limit = payload_limit(payload, "limit").unwrap_or(500);
    with_store(state, |store| {
        let mut items = Vec::<Value>::new();
        let pending_dockets_by_task = store.review_dockets.iter().fold(
            std::collections::HashMap::<String, usize>::new(),
            |mut acc, docket| {
                if docket.status == "pending" {
                    if let Some(task_id) = docket.task_id.as_ref() {
                        *acc.entry(task_id.clone()).or_insert(0) += 1;
                    }
                }
                acc
            },
        );

        for docket in store
            .review_dockets
            .iter()
            .filter(|docket| docket.status == "pending")
        {
            items.push(json!({
                "id": format!("approval:{}", docket.id),
                "source": "approval",
                "sourceLabel": "审批",
                "sourceId": docket.id,
                "title": if docket.title.is_empty() { "未命名审批" } else { docket.title.as_str() },
                "summary": if docket.summary.is_empty() { docket.body.as_str() } else { docket.summary.as_str() },
                "status": docket_panel_status(&docket.status),
                "owner": docket.assigned_to_user_id.as_deref().unwrap_or("人工审批"),
                "sessionTitle": docket.source_kind,
                "priorityLabel": match docket.priority.as_str() {
                    "urgent" => "紧急",
                    "high" => "高",
                    "low" => "低",
                    _ => "普通",
                },
                "progress": 0,
                "artifactCount": docket.artifact_refs.len(),
                "updatedAt": docket.updated_at,
                "createdAt": docket.created_at,
                "reviewCount": 1,
                "taskId": docket.task_id,
                "decisionType": docket.decision_type,
            }));
        }

        for task in &store.collab_tasks {
            let session = store
                .collab_sessions
                .iter()
                .find(|item| item.id == task.session_id);
            let member_name = task.member_id.as_ref().and_then(|member_id| {
                store
                    .collab_members
                    .iter()
                    .find(|member| &member.id == member_id)
                    .map(|member| member.display_name.as_str())
            });
            let latest_report = store
                .collab_progress_reports
                .iter()
                .filter(|report| report.task_id.as_deref() == Some(task.id.as_str()))
                .max_by(|left, right| left.created_at.cmp(&right.created_at));
            let review_count = pending_dockets_by_task.get(&task.id).copied().unwrap_or(0);
            let status = if review_count > 0 {
                "review"
            } else {
                collab_panel_status(&task.status)
            };
            items.push(json!({
                "id": format!("collab:{}", task.id),
                "source": "collaboration",
                "sourceLabel": "团队",
                "sourceId": task.id,
                "title": if task.title.is_empty() { "未命名协作任务" } else { task.title.as_str() },
                "summary": latest_report.map(|report| report.summary.as_str())
                    .or(task.result_summary.as_deref())
                    .or_else(|| if task.description.is_empty() { None } else { Some(task.description.as_str()) })
                    .or_else(|| if task.objective.is_empty() { None } else { Some(task.objective.as_str()) })
                    .unwrap_or(""),
                "status": status,
                "owner": member_name.unwrap_or("未分配"),
                "sessionTitle": session.map(|item| if item.title.is_empty() { item.objective.as_str() } else { item.title.as_str() }).unwrap_or("-"),
                "priorityLabel": if task.priority > 0 { format!("P{}", task.priority) } else { "P0".to_string() },
                "progress": task.progress_percent.or_else(|| latest_report.and_then(|report| report.progress_percent)).unwrap_or(0).clamp(0, 100),
                "artifactCount": task.artifact_ids.len() + task.artifacts.len(),
                "updatedAt": task.updated_at,
                "createdAt": task.created_at,
                "reviewCount": review_count,
                "taskId": task.id,
                "latestReportSummary": latest_report.map(|report| report.summary.as_str()).unwrap_or(""),
                "failureReason": task.failure_reason,
            }));
        }

        for definition in &store.redclaw_job_definitions {
            let latest_execution = store
                .redclaw_job_executions
                .iter()
                .filter(|item| item.definition_id == definition.id)
                .max_by(|left, right| left.updated_at.cmp(&right.updated_at));
            let status = redclaw_definition_status(
                definition,
                latest_execution.map(|execution| execution.status.as_str()),
            );
            let mut latest_execution_value = Map::new();
            if let Some(execution) = latest_execution {
                latest_execution_value.insert("status".to_string(), json!(execution.status));
                latest_execution_value.insert(
                    "scheduledForAt".to_string(),
                    json!(execution.scheduled_for_at),
                );
                latest_execution_value.insert(
                    "lastHeartbeatAt".to_string(),
                    json!(execution.last_heartbeat_at),
                );
                latest_execution_value.insert("lastError".to_string(), json!(execution.last_error));
            }
            items.push(json!({
                "id": format!("redclaw:{}", definition.id),
                "source": "redclaw",
                "sourceLabel": if definition.kind == "long_cycle" { "长周期" } else { "RedClaw" },
                "sourceId": definition.id,
                "sourceTaskId": definition.source_task_id,
                "title": if definition.title.is_empty() { "未命名任务" } else { definition.title.as_str() },
                "summary": redclaw_task_content(definition),
                "status": status,
                "owner": definition.owner_scope.as_deref().unwrap_or("RedClaw"),
                "sessionTitle": definition.source_kind.as_deref().unwrap_or(definition.kind.as_str()),
                "priorityLabel": if definition.requires_confirmation { "待确认" } else if definition.enabled { "已启用" } else { "已停用" },
                "progress": if definition.kind == "long_cycle" {
                    let total = json_i64(&definition.payload, "totalRounds").unwrap_or(0);
                    let completed = json_i64(&definition.payload, "completedRounds").unwrap_or(0);
                    if total > 0 { ((completed * 100) / total).clamp(0, 100) } else { 0 }
                } else if status == "completed" {
                    100
                } else if status == "running" {
                    50
                } else {
                    0
                },
                "artifactCount": latest_execution.map(|execution| execution.artifacts.len()).unwrap_or(0),
                "updatedAt": parse_timestamp_ms(&definition.updated_at).unwrap_or(0),
                "createdAt": parse_timestamp_ms(&definition.created_at).unwrap_or(0),
                "reviewCount": 0,
                "definitionId": definition.id,
                "latestExecution": if latest_execution_value.is_empty() { Value::Null } else { Value::Object(latest_execution_value) },
            }));
        }

        items.sort_by(|left, right| {
            panel_status_rank(
                left.get("status")
                    .and_then(Value::as_str)
                    .unwrap_or_default(),
            )
            .cmp(&panel_status_rank(
                right
                    .get("status")
                    .and_then(Value::as_str)
                    .unwrap_or_default(),
            ))
            .then_with(|| item_updated_at(right).cmp(&item_updated_at(left)))
        });
        if items.len() > limit {
            items.truncate(limit);
        }
        Ok(json!({
            "success": true,
            "items": items,
            "count": items.len(),
        }))
    })
}

pub fn create_review_docket_value(
    app: &AppHandle,
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let docket = with_store_mut(state, |store| create_review_docket(store, payload))?;
    emit_collab_event(
        app,
        "runtime:review-docket-changed",
        None,
        json!({ "docketId": docket.id, "docket": docket }),
    );
    Ok(json!(docket))
}

pub fn decide_review_docket_value(
    app: &AppHandle,
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let decision = with_store_mut(state, |store| decide_review_docket(store, payload))?;
    let action_result =
        route_review_docket_action(app, state, &decision.docket_id, &decision.decision)?;
    emit_collab_event(
        app,
        "runtime:review-docket-changed",
        None,
        json!({ "docketId": decision.docket_id, "decision": decision, "actionResult": action_result.json() }),
    );
    Ok(json!(decision))
}

fn proposed_action_kind(action: Option<&Value>) -> Option<&str> {
    action
        .and_then(Value::as_object)
        .and_then(|value| value.get("kind"))
        .and_then(Value::as_str)
}

fn route_review_docket_action(
    app: &AppHandle,
    state: &State<'_, AppState>,
    docket_id: &str,
    decision: &str,
) -> Result<ApprovalActionRouteResult, String> {
    let docket = with_store(state, |store| {
        get_review_docket(&store, docket_id).ok_or_else(|| "审批项不存在".to_string())
    })?;
    let Some(kind) = proposed_action_kind(docket.proposed_action.as_ref()) else {
        return Ok(ApprovalActionRouteResult {
            kind: "none".to_string(),
            status: "not_applicable",
            message: None,
        });
    };

    match kind {
        "redclaw_task_draft" => apply_redclaw_task_draft_approval(app, state, &docket, decision),
        "collab_task_completion" => Ok(ApprovalActionRouteResult {
            kind: kind.to_string(),
            status: "already_applied",
            message: Some(
                "协作任务状态已由审批 runtime 按 onDecisionTaskStatus 回写。".to_string(),
            ),
        }),
        other => Ok(ApprovalActionRouteResult {
            kind: other.to_string(),
            status: "unsupported",
            message: Some("审批动作 kind 尚未注册业务处理器。".to_string()),
        }),
    }
}

fn apply_redclaw_task_draft_approval(
    app: &AppHandle,
    state: &State<'_, AppState>,
    docket: &ReviewDocketRecord,
    decision: &str,
) -> Result<ApprovalActionRouteResult, String> {
    let action = docket
        .proposed_action
        .as_ref()
        .and_then(Value::as_object)
        .ok_or_else(|| "RedClaw 审批项缺少 proposedAction".to_string())?;
    let draft_id = action
        .get("draftId")
        .and_then(Value::as_str)
        .or(docket.source_id.as_deref())
        .ok_or_else(|| "RedClaw 审批项缺少 draftId".to_string())?;
    let confirm = match decision {
        "approved" => Some(true),
        "rejected" => Some(false),
        _ => None,
    };
    if let Some(confirm) = confirm {
        redclaw_task_control::handle_task_confirm(
            app,
            state,
            &json!({
                "draftId": draft_id,
                "confirm": confirm,
            }),
        )?;
        return Ok(ApprovalActionRouteResult {
            kind: "redclaw_task_draft".to_string(),
            status: "succeeded",
            message: Some(if confirm {
                "RedClaw 草稿已确认。".to_string()
            } else {
                "RedClaw 草稿已丢弃。".to_string()
            }),
        });
    }
    Ok(ApprovalActionRouteResult {
        kind: "redclaw_task_draft".to_string(),
        status: "ignored",
        message: Some("该决定不会自动确认或丢弃 RedClaw 草稿。".to_string()),
    })
}

pub fn archive_review_docket_value(
    app: &AppHandle,
    state: &State<'_, AppState>,
    payload: &Value,
    status: &str,
) -> Result<Value, String> {
    let docket = with_store_mut(state, |store| archive_review_docket(store, payload, status))?;
    emit_collab_event(
        app,
        "runtime:review-docket-changed",
        None,
        json!({ "docketId": docket.id, "docket": docket }),
    );
    Ok(json!(docket))
}

pub fn post_message_value(
    app: &AppHandle,
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let message = with_store_mut(state, |store| post_collab_message(store, payload))?;
    emit_collab_event(
        app,
        "runtime:collab-message-delivered",
        None,
        json!({ "collabSessionId": message.session_id, "message": message }),
    );
    Ok(json!(message))
}

pub fn request_report_value(
    app: &AppHandle,
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let message = with_store_mut(state, |store| request_collab_report(store, payload))?;
    emit_collab_event(
        app,
        "runtime:collab-message-delivered",
        None,
        json!({ "collabSessionId": message.session_id, "message": message }),
    );
    Ok(json!(message))
}

pub fn submit_report_value(
    app: &AppHandle,
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let report = with_store_mut(state, |store| submit_collab_report(store, payload))?;
    emit_collab_event(
        app,
        "runtime:collab-report-submitted",
        None,
        json!({ "collabSessionId": report.session_id, "report": report }),
    );
    Ok(json!(report))
}

pub fn update_session_status_value(
    app: &AppHandle,
    state: &State<'_, AppState>,
    payload: &Value,
    status: &str,
) -> Result<Value, String> {
    let session_id =
        payload_string(payload, "sessionId").ok_or_else(|| "缺少 sessionId".to_string())?;
    let session = with_store_mut(state, |store| {
        update_collab_session_status(store, &session_id, status)
    })?;
    emit_collab_event(
        app,
        "runtime:collab-session-changed",
        session.owner_session_id.as_deref(),
        json!({ "collabSessionId": session.id, "session": session }),
    );
    Ok(json!(session))
}

pub fn tick_reports_value(
    app: &AppHandle,
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let session_id =
        payload_string(payload, "sessionId").ok_or_else(|| "缺少 sessionId".to_string())?;
    let outcome = with_store_mut(state, |store| tick_team_wake_runtime(store, &session_id))?;
    emit_collab_event(
        app,
        "runtime:collab-report-tick",
        None,
        json!({ "collabSessionId": session_id, "outcome": outcome }),
    );
    Ok(json!(outcome))
}

pub fn tool_descriptors_value() -> Value {
    json!(team_tool_descriptors())
}

pub fn execute_tool_value(state: &State<'_, AppState>, payload: &Value) -> Result<Value, String> {
    let action = payload_string(payload, "action").ok_or_else(|| "缺少 action".to_string())?;
    let tool_payload = payload.get("payload").unwrap_or(payload);
    with_store_mut(state, |store| {
        execute_team_tool(store, &action, tool_payload)
    })
}

pub fn mcp_contract_value() -> Value {
    json!({
        "serverName": "redbox-team",
        "tools": crate::mcp::team_mcp_tool_contracts(),
        "toolsListResponse": crate::mcp::team_mcp_tools_list_response()
    })
}

pub fn execute_mcp_tool_value(
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let tool_name =
        payload_string(payload, "toolName").ok_or_else(|| "缺少 toolName".to_string())?;
    let arguments = payload.get("arguments").unwrap_or(payload);
    with_store_mut(state, |store| {
        crate::mcp::execute_team_mcp_tool(store, &tool_name, arguments)
    })
}

pub fn list_agent_backends_value(state: &State<'_, AppState>) -> Result<Value, String> {
    with_store(state, |store| {
        Ok(json!(crate::agent_hub::list_agent_backends(&store)))
    })
}
