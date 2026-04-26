use serde_json::{json, Value};

use crate::runtime::{
    runtime_subagent_role_spec, CollabMailboxMessageRecord, CollabMemberRecord,
    CollabProgressReportRecord, CollabSessionRecord, CollabSessionSnapshot, CollabTaskRecord,
};
use crate::{make_id, now_i64, AppStore};

const DEFAULT_PROGRESS_INTERVAL_MS: i64 = 15 * 60 * 1000;

fn value_string(payload: &Value, key: &str) -> Option<String> {
    payload
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn value_i64(payload: &Value, key: &str) -> Option<i64> {
    payload.get(key).and_then(Value::as_i64)
}

fn value_string_array(payload: &Value, key: &str) -> Vec<String> {
    payload
        .get(key)
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToString::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn value_vec(payload: &Value, key: &str) -> Option<Vec<Value>> {
    payload.get(key).and_then(Value::as_array).cloned()
}

fn value_object(payload: &Value, key: &str) -> Option<Value> {
    payload.get(key).filter(|value| value.is_object()).cloned()
}

fn completion_claim_payload(
    payload: &Value,
    session_id: &str,
    member_id: &str,
    status: &str,
    summary: &str,
) -> Option<Value> {
    if status != "completed" {
        return value_object(payload, "payload");
    }
    let mut object = value_object(payload, "payload")
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    object.insert(
        "completionClaim".to_string(),
        json!({
            "sessionId": session_id,
            "taskId": value_string(payload, "taskId"),
            "memberId": member_id,
            "status": "completed",
            "summary": summary,
            "evidence": value_vec(payload, "evidence").unwrap_or_default(),
            "artifactRefs": value_vec(payload, "artifacts")
                .unwrap_or_default()
                .into_iter()
                .chain(value_string_array(payload, "artifactIds").into_iter().map(|id| json!({ "id": id })))
                .collect::<Vec<_>>(),
            "handoff": value_string(payload, "handoff"),
            "risks": value_string_array(payload, "risks")
        }),
    );
    Some(Value::Object(object))
}

fn value_string_array_or_default(payload: &Value, key: &str, fallback: &[&str]) -> Vec<Value> {
    let values = value_string_array(payload, key);
    if values.is_empty() {
        fallback.iter().map(|value| json!(value)).collect()
    } else {
        values.into_iter().map(Value::String).collect()
    }
}

fn merge_object_defaults(defaults: Value, overlay: Option<Value>) -> Value {
    let mut object = defaults.as_object().cloned().unwrap_or_default();
    if let Some(Value::Object(overlay)) = overlay {
        for (key, value) in overlay {
            object.insert(key, value);
        }
    }
    Value::Object(object)
}

fn role_profile_defaults(role_id: &str) -> Value {
    let role_spec = runtime_subagent_role_spec(role_id);
    let normalized_role = role_id.trim().to_ascii_lowercase();
    let (specialties, good_at, preferred_tasks, avoid_tasks, allowed_families) =
        match normalized_role.as_str() {
            "planner" => (
                vec!["task_planning", "dependency_mapping", "execution_design"],
                vec!["拆解目标", "定义阶段", "发现依赖", "生成可派发任务"],
                vec!["planning", "coordination", "task_decomposition"],
                vec!["final_review", "long_form_copy"],
                vec!["team.task", "team.member", "knowledge.search"],
            ),
            "researcher" => (
                vec!["research", "source_synthesis", "knowledge_retrieval"],
                vec!["检索证据", "整理来源", "标注不确定项", "形成研究摘要"],
                vec!["research", "evidence_collection", "knowledge_lookup"],
                vec!["visual_generation", "final_delivery_claim"],
                vec!["redbox_fs", "knowledge.search", "web.search"],
            ),
            "copywriter" => (
                vec!["writing", "editing", "publishing_copy"],
                vec!["正文成稿", "标题包装", "发布话术", "内容润色"],
                vec!["copywriting", "manuscript_creation", "content_polish"],
                vec!["source_verification", "media_rendering"],
                vec!["manuscripts", "redbox_fs", "redbox_editor"],
            ),
            "image-director" => (
                vec!["image_generation", "cover_direction", "visual_prompting"],
                vec!["视觉方案", "图片提示词", "封面构图", "出图验收"],
                vec!["image_generation", "cover_design", "visual_direction"],
                vec!["backend_debugging", "long_code_review"],
                vec!["media.generate", "image.generate", "redbox_fs"],
            ),
            "animation-director" => (
                vec!["video_animation", "remotion", "shot_design"],
                vec!["镜头规划", "动画结构", "时间线表达", "可执行视觉规范"],
                vec!["animation_design", "video_generation", "timeline_planning"],
                vec!["legal_review", "billing_debugging"],
                vec!["redbox_editor", "media.generate", "redbox_fs"],
            ),
            "reviewer" => (
                vec!["quality_review", "verification", "risk_detection"],
                vec!["验收结果", "发现缺口", "阻止伪成功", "生成修复建议"],
                vec!["review", "verification", "acceptance_check"],
                vec!["primary_authoring", "self_review"],
                vec!["redbox_fs", "team.task", "knowledge.search"],
            ),
            _ => (
                vec!["operations", "maintenance", "runtime_coordination"],
                vec!["后台推进", "状态检查", "恢复任务", "维护运行链路"],
                vec!["ops", "maintenance", "runtime_recovery"],
                vec!["brand_copy", "visual_concept"],
                vec!["app_cli", "redbox_fs", "runtime"],
            ),
        };

    json!({
        "version": 1,
        "memberId": "",
        "displayName": "",
        "roleId": normalized_role,
        "oneLine": role_spec.purpose,
        "persona": role_spec.system_prompt,
        "specialties": specialties,
        "goodAt": good_at,
        "notGoodAt": [],
        "preferredTasks": preferred_tasks,
        "avoidTasks": avoid_tasks,
        "toolPolicy": {
            "allowedFamilies": allowed_families,
            "allowedTools": [],
            "requiresConfirmation": []
        },
        "capacity": {
            "maxExecutorThreads": 5,
            "defaultExecutorThreads": 1
        },
        "decisionBoundary": role_spec.handoff_contract,
        "outputSchema": role_spec.output_schema
    })
}

fn build_member_agent_card(
    member_id: &str,
    display_name: &str,
    role_id: &str,
    capabilities: &[String],
    allowed_tools: &[String],
    payload: &Value,
    metadata: Option<&Value>,
) -> Value {
    let overlay = metadata.and_then(|value| value.get("agentCard").cloned());
    let mut card = merge_object_defaults(role_profile_defaults(role_id), overlay);
    let Some(object) = card.as_object_mut() else {
        return card;
    };

    object.insert("memberId".to_string(), json!(member_id));
    object.insert("displayName".to_string(), json!(display_name));
    object.insert("roleId".to_string(), json!(role_id));
    if !capabilities.is_empty() {
        object.insert("capabilities".to_string(), json!(capabilities));
    }
    if !allowed_tools.is_empty() {
        let policy = object
            .entry("toolPolicy".to_string())
            .or_insert_with(|| json!({}));
        if let Some(policy_object) = policy.as_object_mut() {
            policy_object.insert("allowedTools".to_string(), json!(allowed_tools));
        }
    }

    for key in ["oneLine", "persona", "decisionBoundary", "outputSchema"] {
        if let Some(value) = payload.get(key).filter(|value| !value.is_null()) {
            object.insert(key.to_string(), value.clone());
        }
    }
    for (key, fallback) in [
        ("specialties", &[] as &[&str]),
        ("goodAt", &[] as &[&str]),
        ("notGoodAt", &[] as &[&str]),
        ("preferredTasks", &[] as &[&str]),
        ("avoidTasks", &[] as &[&str]),
    ] {
        let values = value_string_array_or_default(payload, key, fallback);
        if !values.is_empty() {
            object.insert(key.to_string(), Value::Array(values));
        }
    }
    card
}

fn member_metadata_from_payload(
    member_id: &str,
    session_id: &str,
    display_name: &str,
    role_id: &str,
    capabilities: &[String],
    allowed_tools: &[String],
    payload: &Value,
) -> Option<Value> {
    let mut metadata = value_object(payload, "metadata")
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    for key in [
        "advisorId",
        "sourceId",
        "knowledgeSourceId",
        "rootPath",
        "knowledgeRootPath",
    ] {
        if let Some(value) = payload.get(key).filter(|value| !value.is_null()) {
            metadata.insert(key.to_string(), value.clone());
        }
    }
    let metadata_value = Value::Object(metadata.clone());
    let agent_card = build_member_agent_card(
        member_id,
        display_name,
        role_id,
        capabilities,
        allowed_tools,
        payload,
        Some(&metadata_value),
    );
    metadata.insert("agentCard".to_string(), agent_card);
    let plan_overlay = metadata.get("memberTaskPlan");
    metadata.insert(
        "memberTaskPlan".to_string(),
        initial_member_task_plan(member_id, session_id, plan_overlay),
    );
    if metadata.is_empty() {
        None
    } else {
        Some(Value::Object(metadata))
    }
}

fn next_collab_id(prefix: &str, exists: impl Fn(&str) -> bool) -> String {
    let base = make_id(prefix);
    if !exists(&base) {
        return base;
    }
    for attempt in 1..1000 {
        let candidate = format!("{base}-{attempt}");
        if !exists(&candidate) {
            return candidate;
        }
    }
    format!("{base}-{}", now_i64())
}

fn session_exists(store: &AppStore, session_id: &str) -> bool {
    store
        .collab_sessions
        .iter()
        .any(|session| session.id == session_id)
}

fn touch_session(store: &mut AppStore, session_id: &str, now: i64) {
    if let Some(session) = store
        .collab_sessions
        .iter_mut()
        .find(|session| session.id == session_id)
    {
        session.updated_at = now;
    }
}

fn validate_session(store: &AppStore, session_id: &str) -> Result<(), String> {
    if session_exists(store, session_id) {
        Ok(())
    } else {
        Err("协作会话不存在".to_string())
    }
}

fn validate_member(store: &AppStore, session_id: &str, member_id: &str) -> Result<(), String> {
    if store
        .collab_members
        .iter()
        .any(|member| member.session_id == session_id && member.id == member_id)
    {
        Ok(())
    } else {
        Err("协作成员不存在或不属于该会话".to_string())
    }
}

fn validate_task(store: &AppStore, session_id: &str, task_id: &str) -> Result<(), String> {
    if store
        .collab_tasks
        .iter()
        .any(|task| task.session_id == session_id && task.id == task_id)
    {
        Ok(())
    } else {
        Err("协作任务不存在或不属于该会话".to_string())
    }
}

fn apply_task_status(task: &mut CollabTaskRecord, status: String, now: i64) {
    task.status = status.clone();
    task.updated_at = now;
    if matches!(status.as_str(), "running" | "blocked") && task.started_at.is_none() {
        task.started_at = Some(now);
    }
    if matches!(status.as_str(), "completed" | "failed" | "cancelled") {
        task.completed_at = Some(now);
    }
}

pub fn create_collab_session(
    store: &mut AppStore,
    payload: &Value,
) -> Result<CollabSessionRecord, String> {
    let objective = value_string(payload, "objective")
        .or_else(|| value_string(payload, "goal"))
        .unwrap_or_else(|| "协作任务".to_string());
    let title = value_string(payload, "title").unwrap_or_else(|| {
        objective
            .chars()
            .take(48)
            .collect::<String>()
            .trim()
            .to_string()
    });
    let now = now_i64();
    let session = CollabSessionRecord {
        id: next_collab_id("collab-session", |candidate| {
            store
                .collab_sessions
                .iter()
                .any(|session| session.id == candidate)
        }),
        owner_session_id: value_string(payload, "ownerSessionId")
            .or_else(|| value_string(payload, "sessionId")),
        coordinator_member_id: value_string(payload, "coordinatorMemberId"),
        workspace_root: value_string(payload, "workspaceRoot"),
        title,
        objective,
        status: value_string(payload, "status").unwrap_or_else(|| "active".to_string()),
        runtime_mode: value_string(payload, "runtimeMode").unwrap_or_else(|| "default".to_string()),
        source: value_string(payload, "source").unwrap_or_else(|| "internal".to_string()),
        metadata: value_object(payload, "metadata"),
        created_at: now,
        updated_at: now,
        completed_at: None,
    };
    store.collab_sessions.push(session.clone());
    Ok(session)
}

pub fn list_collab_sessions(store: &AppStore) -> Vec<CollabSessionRecord> {
    let mut sessions = store.collab_sessions.clone();
    sessions.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    sessions
}

pub fn update_collab_session_status(
    store: &mut AppStore,
    session_id: &str,
    status: &str,
) -> Result<CollabSessionRecord, String> {
    let now = now_i64();
    let session = store
        .collab_sessions
        .iter_mut()
        .find(|session| session.id == session_id)
        .ok_or_else(|| "协作会话不存在".to_string())?;
    session.status = status.to_string();
    session.updated_at = now;
    if matches!(status, "completed" | "failed" | "archived") {
        session.completed_at.get_or_insert(now);
    }
    Ok(session.clone())
}

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

fn normalized_match_terms(values: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut terms = Vec::new();
    for value in values {
        for part in value
            .split(|ch: char| {
                ch.is_whitespace()
                    || matches!(
                        ch,
                        ',' | '，'
                            | '.'
                            | '。'
                            | ';'
                            | '；'
                            | ':'
                            | '：'
                            | '/'
                            | '|'
                            | '-'
                            | '_'
                            | '('
                            | ')'
                            | '（'
                            | '）'
                    )
            })
            .map(str::trim)
            .filter(|item| !item.is_empty())
        {
            let normalized = part.to_ascii_lowercase();
            if normalized.chars().count() >= 2 && !terms.contains(&normalized) {
                terms.push(normalized);
            }
        }
    }
    terms
}

fn text_term_matches(text: &str, terms: &[String]) -> usize {
    let text = text.to_ascii_lowercase();
    terms
        .iter()
        .filter(|term| text.contains(term.as_str()))
        .count()
}

fn string_array_from_value(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|item| !item.is_empty())
                .map(ToString::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn match_array_terms(value: Option<&Value>, requested: &[String]) -> usize {
    let candidates = string_array_from_value(value);
    requested
        .iter()
        .filter(|requested| {
            candidates.iter().any(|candidate| {
                let candidate = candidate.to_ascii_lowercase();
                candidate == **requested || candidate.contains(requested.as_str())
            })
        })
        .count()
}

fn agent_card_for_member(member: &CollabMemberRecord) -> Value {
    member
        .metadata
        .as_ref()
        .and_then(|metadata| metadata.get("agentCard"))
        .filter(|value| value.is_object())
        .cloned()
        .unwrap_or_else(|| {
            build_member_agent_card(
                &member.id,
                &member.display_name,
                &member.role_id,
                &member.capabilities,
                &member.allowed_tools,
                &json!({}),
                None,
            )
        })
}

fn agent_card_capacity(agent_card: &Value) -> i64 {
    agent_card
        .pointer("/capacity/maxExecutorThreads")
        .and_then(Value::as_i64)
        .filter(|value| *value > 0)
        .unwrap_or(5)
}

fn initial_member_task_plan(member_id: &str, session_id: &str, overlay: Option<&Value>) -> Value {
    let mut plan = json!({
        "version": 1,
        "memberId": member_id,
        "sessionId": session_id,
        "activeExecutors": [],
        "tasks": [],
        "speechQueue": []
    });
    if let Some(Value::Object(overlay)) = overlay {
        if let Some(object) = plan.as_object_mut() {
            for (key, value) in overlay {
                object.insert(key.clone(), value.clone());
            }
            object.insert("memberId".to_string(), json!(member_id));
            object.insert("sessionId".to_string(), json!(session_id));
            object
                .entry("version".to_string())
                .or_insert_with(|| json!(1));
            object
                .entry("activeExecutors".to_string())
                .or_insert_with(|| json!([]));
            object
                .entry("tasks".to_string())
                .or_insert_with(|| json!([]));
            object
                .entry("speechQueue".to_string())
                .or_insert_with(|| json!([]));
        }
    }
    plan
}

fn is_active_task_status(status: &str) -> bool {
    matches!(status, "running" | "in_progress" | "working" | "blocked")
}

fn member_active_executor_count(
    store: &AppStore,
    session_id: &str,
    member_id: &str,
    excluding_task_id: Option<&str>,
) -> i64 {
    store
        .collab_tasks
        .iter()
        .filter(|task| task.session_id == session_id)
        .filter(|task| task.member_id.as_deref() == Some(member_id))
        .filter(|task| excluding_task_id.map_or(true, |task_id| task.id != task_id))
        .filter(|task| is_active_task_status(task.status.as_str()))
        .count() as i64
}

fn member_max_executor_threads(member: &CollabMemberRecord) -> i64 {
    agent_card_capacity(&agent_card_for_member(member))
}

fn validate_member_executor_capacity(
    store: &AppStore,
    session_id: &str,
    member_id: &str,
    status: &str,
    excluding_task_id: Option<&str>,
) -> Result<(), String> {
    if !is_active_task_status(status) {
        return Ok(());
    }
    let member = store
        .collab_members
        .iter()
        .find(|member| member.session_id == session_id && member.id == member_id)
        .ok_or_else(|| "协作成员不存在或不属于该会话".to_string())?;
    let active_count =
        member_active_executor_count(store, session_id, member_id, excluding_task_id);
    let max_threads = member_max_executor_threads(member);
    if active_count >= max_threads {
        Err(format!(
            "成员 {} 的后台执行线程已满：{active_count}/{max_threads}",
            member.display_name
        ))
    } else {
        Ok(())
    }
}

fn task_artifact_refs(task: &CollabTaskRecord) -> Vec<Value> {
    task.artifact_ids
        .iter()
        .map(|artifact_id| json!({ "id": artifact_id }))
        .chain(task.artifacts.iter().cloned())
        .collect()
}

fn speech_item(reason: &str, priority: i64, summary: String, task_id: Option<&str>) -> Value {
    json!({
        "reason": reason,
        "priority": priority,
        "summary": summary,
        "taskId": task_id,
        "createdAt": now_i64()
    })
}

fn upsert_member_task_plan(
    member: &mut CollabMemberRecord,
    task: &CollabTaskRecord,
    report: Option<&CollabProgressReportRecord>,
) {
    let mut metadata = member
        .metadata
        .take()
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    let existing_plan = metadata.get("memberTaskPlan");
    let mut plan = initial_member_task_plan(&member.id, &member.session_id, existing_plan);

    if let Some(object) = plan.as_object_mut() {
        let tasks = object
            .entry("tasks".to_string())
            .or_insert_with(|| json!([]));
        if !tasks.is_array() {
            *tasks = json!([]);
        }
        if let Some(items) = tasks.as_array_mut() {
            let position = items.iter().position(|item| {
                item.get("taskId").and_then(Value::as_str) == Some(task.id.as_str())
            });
            let mut task_plan = position
                .and_then(|index| items.get(index).cloned())
                .unwrap_or_else(|| json!({}));
            if let Some(task_object) = task_plan.as_object_mut() {
                task_object.insert("taskId".to_string(), json!(task.id));
                task_object.insert("status".to_string(), json!(task.status));
                task_object.insert("objective".to_string(), json!(task.objective));
                task_object.insert(
                    "ownerThreadId".to_string(),
                    json!(task
                        .runtime_task_id
                        .clone()
                        .unwrap_or_else(|| format!("executor:{}", task.id))),
                );
                task_object.insert(
                    "artifactRefs".to_string(),
                    Value::Array(task_artifact_refs(task)),
                );
                if let Some(report) = report {
                    task_object.insert("lastReportId".to_string(), json!(report.id));
                    task_object.insert(
                        "lastEvidence".to_string(),
                        report.payload.clone().unwrap_or_else(|| json!({})),
                    );
                    task_object.insert("nextSteps".to_string(), json!(report.next_steps));
                    task_object.insert("blockers".to_string(), json!(report.blockers));
                } else {
                    task_object
                        .entry("nextSteps".to_string())
                        .or_insert_with(|| json!([]));
                    task_object
                        .entry("blockers".to_string())
                        .or_insert_with(|| json!([]));
                    task_object
                        .entry("lastEvidence".to_string())
                        .or_insert_with(|| json!([]));
                }
            }
            if let Some(index) = position {
                items[index] = task_plan;
            } else {
                items.push(task_plan);
            }
        }

        let active_executors = object
            .entry("activeExecutors".to_string())
            .or_insert_with(|| json!([]));
        if !active_executors.is_array() {
            *active_executors = json!([]);
        }
        if let Some(items) = active_executors.as_array_mut() {
            items.retain(|item| {
                item.get("taskId").and_then(Value::as_str) != Some(task.id.as_str())
            });
            if is_active_task_status(task.status.as_str()) {
                items.push(json!({
                    "taskId": task.id,
                    "threadId": task.runtime_task_id.clone().unwrap_or_else(|| format!("executor:{}", task.id)),
                    "status": task.status,
                    "updatedAt": task.updated_at
                }));
            }
        }

        if let Some(report) = report {
            let priority = match report.report_type.as_str() {
                "completion" => 90,
                "failure" | "blocker" => 80,
                "milestone" => 60,
                _ => 40,
            };
            let speech_queue = object
                .entry("speechQueue".to_string())
                .or_insert_with(|| json!([]));
            if !speech_queue.is_array() {
                *speech_queue = json!([]);
            }
            if let Some(items) = speech_queue.as_array_mut() {
                items.push(speech_item(
                    report.report_type.as_str(),
                    priority,
                    report.summary.clone(),
                    report.task_id.as_deref(),
                ));
                items.sort_by(|left, right| {
                    let left_priority = left.get("priority").and_then(Value::as_i64).unwrap_or(0);
                    let right_priority = right.get("priority").and_then(Value::as_i64).unwrap_or(0);
                    right_priority.cmp(&left_priority)
                });
                if items.len() > 20 {
                    items.truncate(20);
                }
            }
        }
    }

    metadata.insert("memberTaskPlan".to_string(), plan);
    member.metadata = Some(Value::Object(metadata));
}

fn remove_member_task_from_plan(
    store: &mut AppStore,
    session_id: &str,
    member_id: &str,
    task_id: &str,
) {
    let Some(member) = store
        .collab_members
        .iter_mut()
        .find(|member| member.session_id == session_id && member.id == member_id)
    else {
        return;
    };
    let mut metadata = member
        .metadata
        .take()
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    let Some(plan) = metadata
        .get_mut("memberTaskPlan")
        .and_then(Value::as_object_mut)
    else {
        member.metadata = Some(Value::Object(metadata));
        return;
    };
    if let Some(tasks) = plan.get_mut("tasks").and_then(Value::as_array_mut) {
        tasks.retain(|item| item.get("taskId").and_then(Value::as_str) != Some(task_id));
    }
    if let Some(active_executors) = plan
        .get_mut("activeExecutors")
        .and_then(Value::as_array_mut)
    {
        active_executors.retain(|item| item.get("taskId").and_then(Value::as_str) != Some(task_id));
    }
    member.metadata = Some(Value::Object(metadata));
}

pub fn match_collab_members_for_task(store: &AppStore, payload: &Value) -> Result<Value, String> {
    let session_id =
        value_string(payload, "sessionId").ok_or_else(|| "缺少 sessionId".to_string())?;
    validate_session(store, &session_id)?;

    let limit = value_i64(payload, "limit")
        .filter(|value| *value > 0)
        .map(|value| value as usize)
        .unwrap_or(5);
    let desired_role = value_string(payload, "roleId").map(|value| value.to_ascii_lowercase());
    let task_type = value_string(payload, "taskType").map(|value| value.to_ascii_lowercase());
    let objective = [
        value_string(payload, "title"),
        value_string(payload, "objective"),
        value_string(payload, "description"),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>();
    let objective_terms = normalized_match_terms(objective);
    let required_capabilities =
        normalized_match_terms(value_string_array(payload, "requiredCapabilities"));
    let required_tool_families =
        normalized_match_terms(value_string_array(payload, "requiredToolFamilies"));
    let preferred_tasks = normalized_match_terms(
        value_string_array(payload, "preferredTasks")
            .into_iter()
            .chain(task_type.clone()),
    );

    let mut candidates = Vec::new();
    for member in list_collab_members(store, &session_id) {
        let agent_card = agent_card_for_member(&member);
        let max_executor_threads = agent_card_capacity(&agent_card);
        let active_executor_count = store
            .collab_tasks
            .iter()
            .filter(|task| task.session_id == session_id)
            .filter(|task| task.member_id.as_deref() == Some(member.id.as_str()))
            .filter(|task| matches!(task.status.as_str(), "running" | "in_progress" | "blocked"))
            .count() as i64;
        let mut score = 0_i64;
        let mut reasons = Vec::<String>::new();

        if let Some(desired_role) = desired_role.as_deref() {
            if desired_role == member.role_id.to_ascii_lowercase() {
                score += 35;
                reasons.push("role_exact".to_string());
            }
        }

        let preferred_task_hits =
            match_array_terms(agent_card.get("preferredTasks"), &preferred_tasks);
        if preferred_task_hits > 0 {
            score += preferred_task_hits as i64 * 20;
            reasons.push(format!("preferred_task:{preferred_task_hits}"));
        }

        let capability_hits = required_capabilities
            .iter()
            .filter(|term| {
                member.capabilities.iter().any(|capability| {
                    let capability = capability.to_ascii_lowercase();
                    capability == **term || capability.contains(term.as_str())
                }) || match_array_terms(agent_card.get("capabilities"), std::slice::from_ref(*term))
                    > 0
                    || match_array_terms(agent_card.get("specialties"), std::slice::from_ref(*term))
                        > 0
            })
            .count();
        if capability_hits > 0 {
            score += capability_hits as i64 * 15;
            reasons.push(format!("capability:{capability_hits}"));
        }

        let tool_family_hits = required_tool_families
            .iter()
            .filter(|term| {
                member.allowed_tools.iter().any(|tool| {
                    let tool = tool.to_ascii_lowercase();
                    tool == **term || tool.contains(term.as_str())
                }) || match_array_terms(
                    agent_card.pointer("/toolPolicy/allowedFamilies"),
                    std::slice::from_ref(*term),
                ) > 0
                    || match_array_terms(
                        agent_card.pointer("/toolPolicy/allowedTools"),
                        std::slice::from_ref(*term),
                    ) > 0
            })
            .count();
        if tool_family_hits > 0 {
            score += tool_family_hits as i64 * 12;
            reasons.push(format!("tool_family:{tool_family_hits}"));
        }

        let specialty_hits = match_array_terms(agent_card.get("specialties"), &objective_terms)
            + match_array_terms(agent_card.get("goodAt"), &objective_terms);
        if specialty_hits > 0 {
            score += specialty_hits as i64 * 8;
            reasons.push(format!("objective_fit:{specialty_hits}"));
        }

        let persona_text = [
            agent_card.get("oneLine").and_then(Value::as_str),
            agent_card.get("persona").and_then(Value::as_str),
            agent_card.get("decisionBoundary").and_then(Value::as_str),
        ]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join(" ");
        let text_hits = text_term_matches(&persona_text, &objective_terms);
        if text_hits > 0 {
            score += text_hits as i64 * 2;
            reasons.push(format!("profile_text:{text_hits}"));
        }

        let avoid_hits = match_array_terms(agent_card.get("avoidTasks"), &preferred_tasks)
            + match_array_terms(agent_card.get("avoidTasks"), &objective_terms);
        if avoid_hits > 0 {
            score -= avoid_hits as i64 * 25;
            reasons.push(format!("avoid_task:{avoid_hits}"));
        }

        if active_executor_count >= max_executor_threads {
            score -= 100;
            reasons.push("capacity_full".to_string());
        } else if active_executor_count > 0 {
            score -= active_executor_count * 5;
            reasons.push(format!("active_load:{active_executor_count}"));
        }

        if reasons.is_empty() {
            reasons.push("fallback_available".to_string());
        }

        candidates.push(json!({
            "memberId": member.id,
            "displayName": member.display_name,
            "roleId": member.role_id,
            "status": member.status,
            "score": score,
            "reasons": reasons,
            "activeExecutorCount": active_executor_count,
            "maxExecutorThreads": max_executor_threads,
            "agentCard": agent_card
        }));
    }

    candidates.sort_by(|left, right| {
        let left_score = left.get("score").and_then(Value::as_i64).unwrap_or(0);
        let right_score = right.get("score").and_then(Value::as_i64).unwrap_or(0);
        right_score.cmp(&left_score).then_with(|| {
            left.get("displayName")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .cmp(
                    right
                        .get("displayName")
                        .and_then(Value::as_str)
                        .unwrap_or_default(),
                )
        })
    });
    candidates.truncate(limit);

    Ok(json!({
        "sessionId": session_id,
        "query": {
            "roleId": desired_role,
            "taskType": task_type,
            "objectiveTerms": objective_terms,
            "requiredCapabilities": required_capabilities,
            "requiredToolFamilies": required_tool_families,
            "preferredTasks": preferred_tasks
        },
        "candidates": candidates
    }))
}

pub fn list_collab_tasks(store: &AppStore, session_id: &str) -> Vec<CollabTaskRecord> {
    let mut tasks: Vec<CollabTaskRecord> = store
        .collab_tasks
        .iter()
        .filter(|task| task.session_id == session_id)
        .cloned()
        .collect();
    tasks.sort_by(|a, b| {
        b.priority
            .cmp(&a.priority)
            .then_with(|| a.created_at.cmp(&b.created_at))
    });
    tasks
}

pub fn list_collab_reports(
    store: &AppStore,
    session_id: &str,
    task_id: Option<&str>,
    member_id: Option<&str>,
    limit: Option<usize>,
) -> Vec<CollabProgressReportRecord> {
    let mut reports: Vec<CollabProgressReportRecord> = store
        .collab_progress_reports
        .iter()
        .filter(|report| report.session_id == session_id)
        .filter(|report| task_id.map_or(true, |value| report.task_id.as_deref() == Some(value)))
        .filter(|report| member_id.map_or(true, |value| report.member_id == value))
        .cloned()
        .collect();
    reports.sort_by(|a, b| a.created_at.cmp(&b.created_at));
    if let Some(limit) = limit.filter(|value| *value > 0) {
        let split_at = reports.len().saturating_sub(limit);
        reports.drain(..split_at);
    }
    reports
}

pub fn list_collab_messages(
    store: &AppStore,
    session_id: &str,
    member_id: Option<&str>,
    task_id: Option<&str>,
    unread_only: bool,
    limit: Option<usize>,
) -> Vec<CollabMailboxMessageRecord> {
    let mut messages: Vec<CollabMailboxMessageRecord> = store
        .collab_mailbox_messages
        .iter()
        .filter(|message| message.session_id == session_id)
        .filter(|message| {
            member_id.map_or(true, |value| {
                message.to_member_id.as_deref() == Some(value)
                    || message.from_member_id.as_deref() == Some(value)
            })
        })
        .filter(|message| task_id.map_or(true, |value| message.task_id.as_deref() == Some(value)))
        .filter(|message| !unread_only || message.read_at.is_none())
        .cloned()
        .collect();
    messages.sort_by(|a, b| a.created_at.cmp(&b.created_at));
    if let Some(limit) = limit.filter(|value| *value > 0) {
        let split_at = messages.len().saturating_sub(limit);
        messages.drain(..split_at);
    }
    messages
}

pub fn collab_session_snapshot(
    store: &AppStore,
    session_id: &str,
    mailbox_limit: Option<usize>,
    report_limit: Option<usize>,
) -> Option<CollabSessionSnapshot> {
    let session = store
        .collab_sessions
        .iter()
        .find(|session| session.id == session_id)?
        .clone();
    let mut members: Vec<CollabMemberRecord> = store
        .collab_members
        .iter()
        .filter(|member| member.session_id == session_id)
        .cloned()
        .collect();
    members.sort_by(|a, b| a.created_at.cmp(&b.created_at));

    let mut tasks: Vec<CollabTaskRecord> = store
        .collab_tasks
        .iter()
        .filter(|task| task.session_id == session_id)
        .cloned()
        .collect();
    tasks.sort_by(|a, b| {
        b.priority
            .cmp(&a.priority)
            .then_with(|| a.created_at.cmp(&b.created_at))
    });

    let mut mailbox: Vec<CollabMailboxMessageRecord> = store
        .collab_mailbox_messages
        .iter()
        .filter(|message| message.session_id == session_id)
        .cloned()
        .collect();
    mailbox.sort_by(|a, b| a.created_at.cmp(&b.created_at));
    if let Some(limit) = mailbox_limit.filter(|value| *value > 0) {
        let split_at = mailbox.len().saturating_sub(limit);
        mailbox.drain(..split_at);
    }

    let mut reports: Vec<CollabProgressReportRecord> = store
        .collab_progress_reports
        .iter()
        .filter(|report| report.session_id == session_id)
        .cloned()
        .collect();
    reports.sort_by(|a, b| a.created_at.cmp(&b.created_at));
    if let Some(limit) = report_limit.filter(|value| *value > 0) {
        let split_at = reports.len().saturating_sub(limit);
        reports.drain(..split_at);
    }

    Some(CollabSessionSnapshot {
        session,
        members,
        tasks,
        mailbox,
        reports,
    })
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

pub fn create_collab_task(
    store: &mut AppStore,
    payload: &Value,
) -> Result<CollabTaskRecord, String> {
    let session_id =
        value_string(payload, "sessionId").ok_or_else(|| "缺少 sessionId".to_string())?;
    validate_session(store, &session_id)?;
    let assigned_member_id = value_string(payload, "memberId");
    if let Some(member_id) = assigned_member_id.as_deref() {
        validate_member(store, &session_id, &member_id)?;
    }
    if let Some(reviewer_member_id) = value_string(payload, "reviewerMemberId") {
        validate_member(store, &session_id, &reviewer_member_id)?;
        if assigned_member_id.as_deref() == Some(reviewer_member_id.as_str()) {
            return Err("任务负责人不能同时作为 reviewer".to_string());
        }
    }
    for task_id in value_string_array(payload, "dependsOnTaskIds") {
        validate_task(store, &session_id, &task_id)?;
    }

    let objective = value_string(payload, "objective")
        .or_else(|| value_string(payload, "goal"))
        .unwrap_or_else(|| "执行协作任务".to_string());
    let status = value_string(payload, "status").unwrap_or_else(|| "todo".to_string());
    if let Some(member_id) = assigned_member_id.as_deref() {
        validate_member_executor_capacity(store, &session_id, member_id, &status, None)?;
    }
    let now = now_i64();
    let task = CollabTaskRecord {
        id: next_collab_id("collab-task", |candidate| {
            store.collab_tasks.iter().any(|task| task.id == candidate)
        }),
        session_id: session_id.clone(),
        parent_task_id: value_string(payload, "parentTaskId"),
        member_id: assigned_member_id,
        reviewer_member_id: value_string(payload, "reviewerMemberId"),
        title: value_string(payload, "title").unwrap_or_else(|| {
            objective
                .chars()
                .take(56)
                .collect::<String>()
                .trim()
                .to_string()
        }),
        description: value_string(payload, "description").unwrap_or_else(|| objective.clone()),
        objective,
        status,
        priority: value_i64(payload, "priority").unwrap_or(0),
        task_type: value_string(payload, "taskType").unwrap_or_else(|| "work".to_string()),
        depends_on_task_ids: value_string_array(payload, "dependsOnTaskIds"),
        blocked_by_task_ids: value_string_array(payload, "blockedByTaskIds"),
        blocks_task_ids: value_string_array(payload, "blocksTaskIds"),
        runtime_task_id: value_string(payload, "runtimeTaskId"),
        external_task_ref: value_string(payload, "externalTaskRef"),
        result_summary: None,
        progress_percent: value_i64(payload, "progressPercent").map(|value| value.clamp(0, 100)),
        artifacts: value_vec(payload, "artifacts").unwrap_or_default(),
        artifact_ids: value_string_array(payload, "artifactIds"),
        due_at: value_i64(payload, "dueAt"),
        metadata: value_object(payload, "metadata"),
        created_at: now,
        updated_at: now,
        started_at: None,
        completed_at: None,
    };
    store.collab_tasks.push(task.clone());
    if let Some(member_id) = task.member_id.as_deref() {
        if let Some(member) = store
            .collab_members
            .iter_mut()
            .find(|member| member.id == member_id && member.session_id == session_id)
        {
            upsert_member_task_plan(member, &task, None);
        }
    }
    touch_session(store, &session_id, now);
    Ok(task)
}

pub fn update_collab_task(
    store: &mut AppStore,
    payload: &Value,
) -> Result<CollabTaskRecord, String> {
    let task_id = value_string(payload, "taskId").ok_or_else(|| "缺少 taskId".to_string())?;
    let task_index = store
        .collab_tasks
        .iter()
        .position(|task| task.id == task_id)
        .ok_or_else(|| "协作任务不存在".to_string())?;
    let session_id = store.collab_tasks[task_index].session_id.clone();
    if let Some(member_id) = value_string(payload, "memberId") {
        validate_member(store, &session_id, &member_id)?;
    }
    if let Some(reviewer_member_id) = value_string(payload, "reviewerMemberId") {
        validate_member(store, &session_id, &reviewer_member_id)?;
        let owner_member_id = value_string(payload, "memberId")
            .or_else(|| store.collab_tasks[task_index].member_id.clone());
        if owner_member_id.as_deref() == Some(reviewer_member_id.as_str()) {
            return Err("任务负责人不能同时作为 reviewer".to_string());
        }
    }
    for task_id in value_string_array(payload, "dependsOnTaskIds") {
        validate_task(store, &session_id, &task_id)?;
    }
    let next_member_id = if payload.get("memberId").is_some() {
        value_string(payload, "memberId")
    } else {
        store.collab_tasks[task_index].member_id.clone()
    };
    let next_status = value_string(payload, "status")
        .unwrap_or_else(|| store.collab_tasks[task_index].status.clone());
    if let Some(member_id) = next_member_id.as_deref() {
        validate_member_executor_capacity(
            store,
            &session_id,
            member_id,
            &next_status,
            Some(&task_id),
        )?;
    }

    let now = now_i64();
    let previous_member_id = store.collab_tasks[task_index].member_id.clone();
    let task = &mut store.collab_tasks[task_index];
    if let Some(value) = value_string(payload, "title") {
        task.title = value;
    }
    if let Some(value) =
        value_string(payload, "objective").or_else(|| value_string(payload, "goal"))
    {
        task.objective = value;
    }
    if let Some(value) = value_string(payload, "memberId") {
        task.member_id = Some(value);
    }
    if payload.get("memberId").is_some() && value_string(payload, "memberId").is_none() {
        task.member_id = None;
    }
    if let Some(value) = value_string(payload, "reviewerMemberId") {
        task.reviewer_member_id = Some(value);
    }
    if payload.get("reviewerMemberId").is_some()
        && value_string(payload, "reviewerMemberId").is_none()
    {
        task.reviewer_member_id = None;
    }
    if let Some(value) = value_string(payload, "description") {
        task.description = value;
    }
    if let Some(value) = value_i64(payload, "priority") {
        task.priority = value;
    }
    if let Some(value) = value_string(payload, "taskType") {
        task.task_type = value;
    }
    if payload.get("dependsOnTaskIds").is_some() {
        task.depends_on_task_ids = value_string_array(payload, "dependsOnTaskIds");
    }
    if payload.get("blockedByTaskIds").is_some() {
        task.blocked_by_task_ids = value_string_array(payload, "blockedByTaskIds");
    }
    if payload.get("blocksTaskIds").is_some() {
        task.blocks_task_ids = value_string_array(payload, "blocksTaskIds");
    }
    if let Some(value) = value_string(payload, "runtimeTaskId") {
        task.runtime_task_id = Some(value);
    }
    if let Some(value) = value_string(payload, "externalTaskRef") {
        task.external_task_ref = Some(value);
    }
    if let Some(value) = value_string(payload, "resultSummary") {
        task.result_summary = Some(value);
    }
    if let Some(value) = value_i64(payload, "progressPercent") {
        task.progress_percent = Some(value.clamp(0, 100));
    }
    if let Some(value) = value_vec(payload, "artifacts") {
        task.artifacts = value;
    }
    if payload.get("artifactIds").is_some() {
        task.artifact_ids = value_string_array(payload, "artifactIds");
    }
    if let Some(value) = value_i64(payload, "dueAt") {
        task.due_at = Some(value);
    }
    if let Some(value) = value_object(payload, "metadata") {
        task.metadata = Some(value);
    }
    if let Some(status) = value_string(payload, "status") {
        apply_task_status(task, status, now);
    } else {
        task.updated_at = now;
    }
    let updated = task.clone();
    if let Some(member_id) = updated.member_id.as_deref() {
        if let Some(member) = store
            .collab_members
            .iter_mut()
            .find(|member| member.id == member_id && member.session_id == session_id)
        {
            upsert_member_task_plan(member, &updated, None);
        }
    }
    if previous_member_id.as_deref() != updated.member_id.as_deref() {
        if let Some(previous_member_id) = previous_member_id.as_deref() {
            remove_member_task_from_plan(store, &session_id, previous_member_id, &updated.id);
        }
    }
    touch_session(store, &session_id, now);
    Ok(updated)
}

pub fn post_collab_message(
    store: &mut AppStore,
    payload: &Value,
) -> Result<CollabMailboxMessageRecord, String> {
    let session_id =
        value_string(payload, "sessionId").ok_or_else(|| "缺少 sessionId".to_string())?;
    validate_session(store, &session_id)?;
    if let Some(member_id) = value_string(payload, "fromMemberId") {
        validate_member(store, &session_id, &member_id)?;
    }
    if let Some(member_id) = value_string(payload, "toMemberId") {
        validate_member(store, &session_id, &member_id)?;
    }
    if let Some(task_id) = value_string(payload, "taskId") {
        validate_task(store, &session_id, &task_id)?;
    }
    let now = now_i64();
    let message = CollabMailboxMessageRecord {
        id: next_collab_id("collab-msg", |candidate| {
            store
                .collab_mailbox_messages
                .iter()
                .any(|message| message.id == candidate)
        }),
        session_id: session_id.clone(),
        from_member_id: value_string(payload, "fromMemberId"),
        to_member_id: value_string(payload, "toMemberId"),
        from_kind: value_string(payload, "fromKind").unwrap_or_else(|| "system".to_string()),
        task_id: value_string(payload, "taskId"),
        kind: value_string(payload, "kind").unwrap_or_else(|| "message".to_string()),
        message_type: value_string(payload, "messageType")
            .or_else(|| value_string(payload, "kind"))
            .unwrap_or_else(|| "message".to_string()),
        status: value_string(payload, "status").unwrap_or_else(|| "unread".to_string()),
        subject: value_string(payload, "subject"),
        body: value_string(payload, "body").unwrap_or_default(),
        attachment_refs: value_string_array(payload, "attachmentRefs"),
        payload: value_object(payload, "payload"),
        created_at: now,
        read_at: None,
    };
    store.collab_mailbox_messages.push(message.clone());
    touch_session(store, &session_id, now);
    Ok(message)
}

pub fn read_collab_mailbox(
    store: &mut AppStore,
    payload: &Value,
) -> Result<Vec<CollabMailboxMessageRecord>, String> {
    let session_id =
        value_string(payload, "sessionId").ok_or_else(|| "缺少 sessionId".to_string())?;
    validate_session(store, &session_id)?;
    let member_id = value_string(payload, "memberId");
    if let Some(member_id) = member_id.as_deref() {
        validate_member(store, &session_id, member_id)?;
    }
    let unread_only = payload
        .get("unreadOnly")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let mark_read = payload
        .get("markRead")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let task_id = value_string(payload, "taskId");
    let limit = value_i64(payload, "limit")
        .filter(|value| *value > 0)
        .map(|value| value as usize);
    let messages = list_collab_messages(
        store,
        &session_id,
        member_id.as_deref(),
        task_id.as_deref(),
        unread_only,
        limit,
    );
    if mark_read {
        let now = now_i64();
        for message in store.collab_mailbox_messages.iter_mut() {
            if messages.iter().any(|item| item.id == message.id) && message.read_at.is_none() {
                message.read_at = Some(now);
                message.status = "read".to_string();
            }
        }
    }
    Ok(messages)
}

pub fn cleanup_collab_mailbox(store: &mut AppStore, session_id: &str, keep_latest: usize) -> usize {
    let keep_latest = keep_latest.max(1);
    let mut read_messages: Vec<CollabMailboxMessageRecord> = store
        .collab_mailbox_messages
        .iter()
        .filter(|message| message.session_id == session_id && message.read_at.is_some())
        .cloned()
        .collect();
    if read_messages.len() <= keep_latest {
        return 0;
    }
    read_messages.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    let keep_ids = read_messages
        .iter()
        .take(keep_latest)
        .map(|message| message.id.clone())
        .collect::<std::collections::HashSet<_>>();
    let before = store.collab_mailbox_messages.len();
    store.collab_mailbox_messages.retain(|message| {
        message.session_id != session_id
            || message.read_at.is_none()
            || keep_ids.contains(&message.id)
    });
    before.saturating_sub(store.collab_mailbox_messages.len())
}

pub fn submit_collab_report(
    store: &mut AppStore,
    payload: &Value,
) -> Result<CollabProgressReportRecord, String> {
    let session_id =
        value_string(payload, "sessionId").ok_or_else(|| "缺少 sessionId".to_string())?;
    let member_id = value_string(payload, "memberId").ok_or_else(|| "缺少 memberId".to_string())?;
    validate_session(store, &session_id)?;
    validate_member(store, &session_id, &member_id)?;
    if let Some(task_id) = value_string(payload, "taskId") {
        validate_task(store, &session_id, &task_id)?;
    }

    let now = now_i64();
    let status = value_string(payload, "status").unwrap_or_else(|| "reported".to_string());
    let summary = value_string(payload, "summary").unwrap_or_default();
    let report = CollabProgressReportRecord {
        id: next_collab_id("collab-report", |candidate| {
            store
                .collab_progress_reports
                .iter()
                .any(|report| report.id == candidate)
        }),
        session_id: session_id.clone(),
        member_id: member_id.clone(),
        task_id: value_string(payload, "taskId"),
        report_type: value_string(payload, "reportType").unwrap_or_else(|| {
            match status.as_str() {
                "blocked" => "blocker",
                "completed" => "completion",
                "failed" => "failure",
                _ => "periodic",
            }
            .to_string()
        }),
        status: status.clone(),
        summary: summary.clone(),
        next_action: value_string(payload, "nextAction"),
        next_steps: value_string_array(payload, "nextSteps"),
        progress_percent: value_i64(payload, "progressPercent").map(|value| value.clamp(0, 100)),
        blockers: value_string_array(payload, "blockers"),
        artifacts: value_vec(payload, "artifacts").unwrap_or_default(),
        artifact_ids: value_string_array(payload, "artifactIds"),
        payload: completion_claim_payload(payload, &session_id, &member_id, &status, &summary),
        created_at: now,
    };
    store.collab_progress_reports.push(report.clone());

    if let Some(member) = store
        .collab_members
        .iter_mut()
        .find(|member| member.id == member_id && member.session_id == session_id)
    {
        member.status = value_string(payload, "memberStatus").unwrap_or_else(|| {
            match status.as_str() {
                "blocked" => "blocked",
                "completed" => "completed",
                "failed" => "failed",
                "cancelled" => "idle",
                _ => "working",
            }
            .to_string()
        });
        member.current_task_id = report.task_id.clone().or(member.current_task_id.clone());
        member.last_seen_at = Some(now);
        member.last_report_at = Some(now);
        member.updated_at = now;
    }

    let mut updated_task = None;
    if let Some(task_id) = report.task_id.clone() {
        if let Some(task) = store
            .collab_tasks
            .iter_mut()
            .find(|task| task.id == task_id && task.session_id == session_id)
        {
            if matches!(
                status.as_str(),
                "todo" | "running" | "blocked" | "completed" | "failed" | "cancelled"
            ) {
                apply_task_status(task, status, now);
            } else {
                task.updated_at = now;
            }
            if !report.summary.is_empty() {
                task.result_summary = Some(report.summary.clone());
            }
            if !report.artifacts.is_empty() {
                if report.report_type == "artifact" {
                    task.artifacts.extend(report.artifacts.clone());
                } else {
                    task.artifacts = report.artifacts.clone();
                }
            }
            if !report.artifact_ids.is_empty() {
                if report.report_type == "artifact" {
                    for artifact_id in report.artifact_ids.iter() {
                        if !task.artifact_ids.contains(artifact_id) {
                            task.artifact_ids.push(artifact_id.clone());
                        }
                    }
                } else {
                    task.artifact_ids = report.artifact_ids.clone();
                }
            }
            if report.progress_percent.is_some() {
                task.progress_percent = report.progress_percent;
            }
            updated_task = Some(task.clone());
        }
    }
    if let Some(task) = updated_task.as_ref() {
        if let Some(member) = store
            .collab_members
            .iter_mut()
            .find(|member| member.id == member_id && member.session_id == session_id)
        {
            upsert_member_task_plan(member, task, Some(&report));
        }
    }

    touch_session(store, &session_id, now);
    Ok(report)
}

pub fn attach_collab_artifact(
    store: &mut AppStore,
    payload: &Value,
) -> Result<CollabProgressReportRecord, String> {
    let session_id =
        value_string(payload, "sessionId").ok_or_else(|| "缺少 sessionId".to_string())?;
    let task_id = value_string(payload, "taskId").ok_or_else(|| "缺少 taskId".to_string())?;
    validate_session(store, &session_id)?;
    validate_task(store, &session_id, &task_id)?;

    let mut artifacts = value_vec(payload, "artifacts").unwrap_or_default();
    if let Some(artifact) = payload.get("artifact").filter(|value| value.is_object()) {
        artifacts.push(artifact.clone());
    }
    let artifact_ids = value_string_array(payload, "artifactIds");
    if artifacts.is_empty() && artifact_ids.is_empty() {
        return Err("缺少 artifact 或 artifactIds".to_string());
    }

    let report_payload = json!({
        "sessionId": session_id,
        "memberId": value_string(payload, "memberId").ok_or_else(|| "缺少 memberId".to_string())?,
        "taskId": task_id,
        "status": value_string(payload, "status").unwrap_or_else(|| "running".to_string()),
        "reportType": "artifact",
        "summary": value_string(payload, "summary").unwrap_or_else(|| "已附加任务产物。".to_string()),
        "artifacts": artifacts,
        "artifactIds": artifact_ids,
        "payload": value_object(payload, "payload").unwrap_or_else(|| json!({}))
    });
    submit_collab_report(store, &report_payload)
}

pub fn raise_collab_blocker(
    store: &mut AppStore,
    payload: &Value,
) -> Result<CollabProgressReportRecord, String> {
    let blocker = value_string(payload, "blocker")
        .or_else(|| value_string(payload, "summary"))
        .unwrap_or_else(|| "任务被阻塞".to_string());
    let mut report_payload = payload.clone();
    let object = report_payload
        .as_object_mut()
        .ok_or_else(|| "blocker payload must be an object".to_string())?;
    object
        .entry("status".to_string())
        .or_insert_with(|| json!("blocked"));
    object
        .entry("reportType".to_string())
        .or_insert_with(|| json!("blocker"));
    object
        .entry("summary".to_string())
        .or_insert_with(|| json!(blocker.clone()));
    object
        .entry("blockers".to_string())
        .or_insert_with(|| json!([blocker]));
    submit_collab_report(store, &report_payload)
}

pub fn request_collab_report(
    store: &mut AppStore,
    payload: &Value,
) -> Result<CollabMailboxMessageRecord, String> {
    let mut request_payload = payload.clone();
    let object = request_payload
        .as_object_mut()
        .ok_or_else(|| "request report payload must be an object".to_string())?;
    object
        .entry("kind".to_string())
        .or_insert_with(|| Value::String("report_request".to_string()));
    object
        .entry("messageType".to_string())
        .or_insert_with(|| Value::String("report_request".to_string()));
    object
        .entry("fromKind".to_string())
        .or_insert_with(|| Value::String("system".to_string()));
    object.entry("body".to_string()).or_insert_with(|| {
        Value::String("请提交当前任务进度、阻塞点、下一步和可用产物。".to_string())
    });
    post_collab_message(store, &request_payload)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn collab_report_updates_member_and_task_board_state() {
        let mut store = AppStore::default();
        let session = create_collab_session(
            &mut store,
            &json!({
                "title": "视频工作流改造",
                "objective": "让团队成员并行处理视频任务",
                "runtimeMode": "default"
            }),
        )
        .unwrap();
        let member = add_collab_member(
            &mut store,
            &json!({
                "sessionId": session.id,
                "displayName": "视频工程师",
                "roleId": "video-engineer",
                "capabilities": ["ffmpeg", "remotion"]
            }),
        )
        .unwrap();
        let task = create_collab_task(
            &mut store,
            &json!({
                "sessionId": session.id,
                "memberId": member.id,
                "title": "生成剪辑任务 DAG",
                "objective": "把视频处理拆成可追踪任务",
                "priority": 8
            }),
        )
        .unwrap();

        let report = submit_collab_report(
            &mut store,
            &json!({
                "sessionId": session.id,
                "memberId": member.id,
                "taskId": task.id,
                "status": "running",
                "summary": "已完成任务 DAG 初版",
                "nextAction": "接入执行器",
                "blockers": []
            }),
        )
        .unwrap();

        assert_eq!(report.status, "running");
        let snapshot = collab_session_snapshot(&store, &session.id, None, None).unwrap();
        assert_eq!(
            snapshot.members[0].current_task_id.as_deref(),
            Some(task.id.as_str())
        );
        assert_eq!(snapshot.members[0].status, "working");
        assert_eq!(snapshot.tasks[0].status, "running");
        assert_eq!(
            snapshot.tasks[0].result_summary.as_deref(),
            Some("已完成任务 DAG 初版")
        );
        assert_eq!(snapshot.reports.len(), 1);
    }

    #[test]
    fn collab_task_dependency_must_belong_to_same_session() {
        let mut store = AppStore::default();
        let first = create_collab_session(&mut store, &json!({ "objective": "first" })).unwrap();
        let second = create_collab_session(&mut store, &json!({ "objective": "second" })).unwrap();
        let external = create_collab_task(
            &mut store,
            &json!({
                "sessionId": first.id,
                "title": "外部任务"
            }),
        )
        .unwrap();

        let result = create_collab_task(
            &mut store,
            &json!({
                "sessionId": second.id,
                "title": "错误依赖",
                "dependsOnTaskIds": [external.id]
            }),
        );

        assert!(result.is_err());
    }

    #[test]
    fn collab_member_spawn_persists_agent_card_profile() {
        let mut store = AppStore::default();
        let session =
            create_collab_session(&mut store, &json!({ "objective": "profile" })).unwrap();

        let member = add_collab_member(
            &mut store,
            &json!({
                "sessionId": session.id,
                "displayName": "研究员",
                "roleId": "researcher",
                "capabilities": ["knowledge_retrieval"]
            }),
        )
        .unwrap();

        let agent_card = member
            .metadata
            .as_ref()
            .and_then(|metadata| metadata.get("agentCard"))
            .expect("agent card should be persisted");
        assert_eq!(
            agent_card.get("memberId").and_then(Value::as_str),
            Some(member.id.as_str())
        );
        assert_eq!(
            agent_card.get("displayName").and_then(Value::as_str),
            Some("研究员")
        );
        assert_eq!(
            agent_card.get("roleId").and_then(Value::as_str),
            Some("researcher")
        );
        assert_eq!(
            agent_card
                .pointer("/capacity/maxExecutorThreads")
                .and_then(Value::as_i64),
            Some(5)
        );
        assert!(agent_card
            .get("preferredTasks")
            .and_then(Value::as_array)
            .unwrap()
            .iter()
            .any(|value| value == "research"));
    }

    #[test]
    fn collab_member_match_prefers_task_specific_agent_card() {
        let mut store = AppStore::default();
        let session =
            create_collab_session(&mut store, &json!({ "objective": "visual production" }))
                .unwrap();
        add_collab_member(
            &mut store,
            &json!({
                "sessionId": session.id,
                "displayName": "研究员",
                "roleId": "researcher",
                "capabilities": ["knowledge_retrieval"]
            }),
        )
        .unwrap();
        add_collab_member(
            &mut store,
            &json!({
                "sessionId": session.id,
                "displayName": "图片导演",
                "roleId": "image-director",
                "capabilities": ["image_generation"],
                "allowedTools": ["image.generate"]
            }),
        )
        .unwrap();

        let result = match_collab_members_for_task(
            &store,
            &json!({
                "sessionId": session.id,
                "title": "生成封面图",
                "objective": "用生图工具生成封面和视觉方案",
                "taskType": "image_generation",
                "requiredCapabilities": ["image_generation"],
                "requiredToolFamilies": ["image.generate"],
                "limit": 2
            }),
        )
        .unwrap();

        let first = result
            .get("candidates")
            .and_then(Value::as_array)
            .and_then(|items| items.first())
            .expect("candidate should exist");
        assert_eq!(
            first.get("roleId").and_then(Value::as_str),
            Some("image-director")
        );
        assert!(first
            .get("reasons")
            .and_then(Value::as_array)
            .unwrap()
            .iter()
            .any(|value| value
                .as_str()
                .unwrap_or_default()
                .starts_with("preferred_task")));
    }

    #[test]
    fn collab_member_agent_card_allows_custom_profile_overlay() {
        let mut store = AppStore::default();
        let session =
            create_collab_session(&mut store, &json!({ "objective": "custom profile" })).unwrap();

        let member = add_collab_member(
            &mut store,
            &json!({
                "sessionId": session.id,
                "displayName": "审稿人",
                "roleId": "reviewer",
                "metadata": {
                    "agentCard": {
                        "oneLine": "专门检查交付风险",
                        "preferredTasks": ["acceptance_check"]
                    }
                }
            }),
        )
        .unwrap();

        let agent_card = member
            .metadata
            .as_ref()
            .and_then(|metadata| metadata.get("agentCard"))
            .unwrap();
        assert_eq!(
            agent_card.get("oneLine").and_then(Value::as_str),
            Some("专门检查交付风险")
        );
        assert!(agent_card
            .get("preferredTasks")
            .and_then(Value::as_array)
            .unwrap()
            .iter()
            .any(|value| value == "acceptance_check"));
    }

    #[test]
    fn collab_member_task_plan_tracks_assignment_and_completion_claim() {
        let mut store = AppStore::default();
        let session = create_collab_session(&mut store, &json!({ "objective": "plan" })).unwrap();
        let member = add_collab_member(
            &mut store,
            &json!({ "sessionId": session.id, "displayName": "执行者" }),
        )
        .unwrap();
        let task = create_collab_task(
            &mut store,
            &json!({
                "sessionId": session.id,
                "memberId": member.id,
                "title": "执行任务",
                "status": "running"
            }),
        )
        .unwrap();

        let report = submit_collab_report(
            &mut store,
            &json!({
                "sessionId": session.id,
                "memberId": member.id,
                "taskId": task.id,
                "status": "completed",
                "summary": "完成任务",
                "evidence": [{ "kind": "file", "path": "workspace://done.md" }],
                "handoff": "交给 reviewer",
                "risks": []
            }),
        )
        .unwrap();

        assert_eq!(report.report_type, "completion");
        assert!(report
            .payload
            .as_ref()
            .and_then(|payload| payload.get("completionClaim"))
            .is_some());
        let member = store
            .collab_members
            .iter()
            .find(|item| item.id == member.id)
            .unwrap();
        let plan = member
            .metadata
            .as_ref()
            .and_then(|metadata| metadata.get("memberTaskPlan"))
            .unwrap();
        assert_eq!(
            plan.pointer("/tasks/0/status").and_then(Value::as_str),
            Some("completed")
        );
        assert_eq!(
            plan.pointer("/speechQueue/0/reason")
                .and_then(Value::as_str),
            Some("completion")
        );
    }

    #[test]
    fn collab_member_executor_capacity_blocks_extra_running_tasks() {
        let mut store = AppStore::default();
        let session =
            create_collab_session(&mut store, &json!({ "objective": "capacity" })).unwrap();
        let member = add_collab_member(
            &mut store,
            &json!({
                "sessionId": session.id,
                "displayName": "有限执行者",
                "metadata": {
                    "agentCard": {
                        "capacity": { "maxExecutorThreads": 1, "defaultExecutorThreads": 1 }
                    }
                }
            }),
        )
        .unwrap();
        create_collab_task(
            &mut store,
            &json!({
                "sessionId": session.id,
                "memberId": member.id,
                "title": "第一个任务",
                "status": "running"
            }),
        )
        .unwrap();

        let result = create_collab_task(
            &mut store,
            &json!({
                "sessionId": session.id,
                "memberId": member.id,
                "title": "第二个任务",
                "status": "running"
            }),
        );

        assert!(result.is_err());
    }

    #[test]
    fn collab_artifact_and_blocker_helpers_submit_structured_reports() {
        let mut store = AppStore::default();
        let session =
            create_collab_session(&mut store, &json!({ "objective": "helpers" })).unwrap();
        let member = add_collab_member(
            &mut store,
            &json!({ "sessionId": session.id, "displayName": "成员" }),
        )
        .unwrap();
        let task = create_collab_task(
            &mut store,
            &json!({
                "sessionId": session.id,
                "memberId": member.id,
                "title": "产物任务"
            }),
        )
        .unwrap();

        let artifact_report = attach_collab_artifact(
            &mut store,
            &json!({
                "sessionId": session.id,
                "memberId": member.id,
                "taskId": task.id,
                "artifact": { "kind": "note", "path": "workspace://a.md" }
            }),
        )
        .unwrap();
        assert_eq!(artifact_report.report_type, "artifact");
        let blocker_report = raise_collab_blocker(
            &mut store,
            &json!({
                "sessionId": session.id,
                "memberId": member.id,
                "taskId": task.id,
                "blocker": "等待输入"
            }),
        )
        .unwrap();
        assert_eq!(blocker_report.report_type, "blocker");
        assert_eq!(blocker_report.status, "blocked");
    }
}
