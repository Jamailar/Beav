use super::*;
use serde_json::Map;

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

        let redclaw_definitions = redclaw_store::list_job_definitions(&store);
        let redclaw_executions = redclaw_store::list_job_executions(&store);
        for definition in &redclaw_definitions {
            let latest_execution = redclaw_executions
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
