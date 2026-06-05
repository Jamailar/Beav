use super::*;

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

pub(super) fn initial_member_task_plan(
    member_id: &str,
    session_id: &str,
    overlay: Option<&Value>,
) -> Value {
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

pub(super) fn validate_member_executor_capacity(
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

pub(super) fn upsert_member_task_plan(
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

pub(super) fn remove_member_task_from_plan(
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
