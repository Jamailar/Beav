use serde_json::{json, Map, Value};
use tauri::{AppHandle, State};

use crate::events::emit_runtime_task_checkpoint_saved;
use crate::persistence::{with_store, with_store_mut};
use crate::runtime::{
    RedclawJobDefinitionRecord, RedclawLongCycleTaskRecord, RedclawScheduledTaskRecord,
};
use crate::scheduler::task_policy::{
    preview_task_intent, task_contract_version, TaskIntentSchema, TaskPolicyDecisionKind,
    TaskPreviewResult,
};
use crate::scheduler::{
    cancel_job_execution, clear_definition_cooldown, emit_scheduler_snapshot,
    sync_redclaw_job_definitions,
};
use crate::{
    make_id, normalize_optional_string, now_i64, now_iso, payload_field, payload_string, AppState,
};

const TASK_DRAFT_KIND_SCHEDULED: &str = "scheduled_draft";
const TASK_DRAFT_KIND_LONG_CYCLE: &str = "long_cycle_draft";

pub fn handle_task_preview(
    app: &AppHandle,
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let intent = parse_task_intent(payload)?;
    let preview = with_store(state, |store| {
        preview_task_intent(&store, &intent, now_i64())
    })?;
    emit_runtime_task_checkpoint_saved(
        app,
        None,
        None,
        "task.previewed",
        "Task preview evaluated",
        Some(json!({
            "name": intent.name,
            "ownerScope": intent.owner_scope,
            "actionType": intent.action_type,
            "decision": preview.decision,
            "previewRunAt": preview.preview_run_at,
            "policyDecision": preview.policy_decision,
        })),
    );
    Ok(json!({
        "success": true,
        "decision": preview.decision,
        "previewToken": preview.preview_token,
        "previewRunAt": preview.preview_run_at,
        "policyDecision": preview.policy_decision,
        "policyWarnings": preview.policy_warnings,
        "rejectionReasons": preview.rejection_reasons,
        "conflictTasks": preview.conflict_tasks,
        "requiresConfirmation": true,
        "definitionFingerprint": preview.definition_fingerprint,
        "policySignature": preview.policy_signature,
        "normalized": preview.normalized,
    }))
}

pub fn handle_task_create(
    app: &AppHandle,
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let intent = parse_task_intent(payload)?;
    let preview_token = payload_string(payload, "previewToken")
        .ok_or_else(|| "previewToken is required".to_string())?;
    let created = with_store_mut(state, |store| {
        let preview = preview_task_intent(store, &intent, now_i64())?;
        if preview.preview_token != preview_token {
            return Err("previewToken 已过期或与当前 intent 不匹配".to_string());
        }
        if matches!(preview.policy_decision, TaskPolicyDecisionKind::Reject) {
            return Err(preview
                .rejection_reasons
                .first()
                .cloned()
                .unwrap_or_else(|| "任务策略拒绝创建".to_string()));
        }
        if let Some(existing) = store.redclaw_job_definitions.iter().find(|item| {
            item.requires_confirmation
                && item.owner_scope.as_deref() == Some(intent.owner_scope.as_str())
                && item.definition_fingerprint.as_deref()
                    == Some(preview.definition_fingerprint.as_str())
        }) {
            return Ok(json!({
                "draftId": existing.id,
                "definition": existing,
                "created": false,
                "preview": preview,
            }));
        }

        let draft = build_draft_definition(&intent, &preview);
        store.redclaw_job_definitions.push(draft.clone());
        Ok(json!({
            "draftId": draft.id,
            "definition": draft,
            "created": true,
            "preview": preview,
        }))
    })?;

    emit_runtime_task_checkpoint_saved(
        app,
        created.get("draftId").and_then(Value::as_str),
        None,
        "task.created",
        "Task draft created",
        Some(created.clone()),
    );
    emit_scheduler_snapshot(app, state);
    Ok(json!({
        "success": true,
        "draftId": created.get("draftId").cloned().unwrap_or(Value::Null),
        "definition": created.get("definition").cloned().unwrap_or(Value::Null),
        "preview": created.get("preview").cloned().unwrap_or(Value::Null),
        "created": created.get("created").and_then(Value::as_bool).unwrap_or(false),
    }))
}

pub fn handle_task_confirm(
    app: &AppHandle,
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let draft_id =
        payload_string(payload, "draftId").ok_or_else(|| "draftId is required".to_string())?;
    let confirm = payload_field(payload, "confirm")
        .and_then(Value::as_bool)
        .unwrap_or(false);

    let result = with_store_mut(state, |store| {
        let draft = store
            .redclaw_job_definitions
            .iter()
            .find(|item| item.id == draft_id && item.requires_confirmation)
            .cloned()
            .ok_or_else(|| "任务草稿不存在".to_string())?;

        if !confirm {
            store
                .redclaw_job_definitions
                .retain(|item| item.id != draft_id);
            return Ok(json!({
                "confirmed": false,
                "cancelled": true,
                "draftId": draft_id,
            }));
        }

        let intent = parse_task_intent(
            draft
                .payload
                .get("intent")
                .ok_or_else(|| "任务草稿缺少 intent".to_string())?,
        )?;
        let preview = preview_task_intent(store, &intent, now_i64())?;
        if matches!(preview.policy_decision, TaskPolicyDecisionKind::Reject) {
            return Err(preview
                .rejection_reasons
                .first()
                .cloned()
                .unwrap_or_else(|| "任务策略拒绝确认".to_string()));
        }

        let definition = promote_draft_definition(store, &draft, &intent, &preview)?;
        store
            .redclaw_job_definitions
            .retain(|item| item.id != draft_id);
        Ok(json!({
            "confirmed": true,
            "draftId": draft_id,
            "jobDefinitionId": definition.id,
            "definition": definition,
        }))
    })?;

    emit_runtime_task_checkpoint_saved(
        app,
        result
            .get("jobDefinitionId")
            .and_then(Value::as_str)
            .or_else(|| result.get("draftId").and_then(Value::as_str)),
        None,
        "task.confirmed",
        "Task draft confirmation resolved",
        Some(result.clone()),
    );
    emit_scheduler_snapshot(app, state);
    Ok(json!({ "success": true, "result": result }))
}

pub fn create_confirmed_task_from_intent(
    app: &AppHandle,
    state: &State<'_, AppState>,
    intent: TaskIntentSchema,
) -> Result<Value, String> {
    let preview = handle_task_preview(app, state, &json!({ "intent": intent.clone() }))?;
    let preview_token = preview
        .get("previewToken")
        .and_then(Value::as_str)
        .ok_or_else(|| "task preview 缺少 previewToken".to_string())?;
    let created = handle_task_create(
        app,
        state,
        &json!({
            "intent": intent,
            "previewToken": preview_token,
        }),
    )?;
    let draft_id = created
        .get("draftId")
        .and_then(Value::as_str)
        .ok_or_else(|| "task create 缺少 draftId".to_string())?;
    let confirmed = handle_task_confirm(
        app,
        state,
        &json!({
            "draftId": draft_id,
            "confirm": true,
        }),
    )?;
    Ok(confirmed
        .get("result")
        .cloned()
        .unwrap_or_else(|| json!({ "confirmed": true })))
}

pub fn handle_task_update(
    app: &AppHandle,
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let job_definition_id = payload_string(payload, "jobDefinitionId")
        .ok_or_else(|| "jobDefinitionId is required".to_string())?;
    let reason = payload_string(payload, "reason")
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "reason is required".to_string())?;
    let patch = payload_field(payload, "patch")
        .cloned()
        .unwrap_or_else(|| json!({}));

    let result = with_store_mut(state, |store| {
        let existing = store
            .redclaw_job_definitions
            .iter()
            .find(|item| item.id == job_definition_id)
            .cloned()
            .ok_or_else(|| "任务定义不存在".to_string())?;
        if existing.requires_confirmation {
            return Err("草稿任务请重新 preview/create/confirm，不支持直接 update".to_string());
        }
        let mut intent = intent_from_definition(store, &existing)?;
        merge_patch_into_intent(&mut intent, &patch)?;
        let mut preview_store = store.clone();
        if let Some(existing_definition) = preview_store
            .redclaw_job_definitions
            .iter_mut()
            .find(|item| item.id == job_definition_id)
        {
            clear_definition_cooldown(existing_definition);
        }
        let preview = preview_task_intent(&preview_store, &intent, now_i64())?;
        if matches!(preview.policy_decision, TaskPolicyDecisionKind::Reject) {
            return Err(preview
                .rejection_reasons
                .first()
                .cloned()
                .unwrap_or_else(|| "更新后的任务被策略拒绝".to_string()));
        }
        apply_intent_update(store, &existing, &intent, &preview, &reason)?;
        sync_redclaw_job_definitions(store);
        let updated = store
            .redclaw_job_definitions
            .iter()
            .find(|item| item.id == job_definition_id)
            .cloned()
            .ok_or_else(|| "更新后任务定义不存在".to_string())?;
        Ok(json!({
            "jobDefinitionId": job_definition_id,
            "definition": updated,
            "preview": preview,
        }))
    })?;

    emit_runtime_task_checkpoint_saved(
        app,
        Some(&job_definition_id),
        None,
        "task.updated",
        "Task definition updated",
        Some(json!({
            "jobDefinitionId": job_definition_id,
            "reason": reason,
            "patch": patch,
        })),
    );
    emit_scheduler_snapshot(app, state);
    Ok(json!({ "success": true, "result": result }))
}

pub fn handle_task_cancel(
    app: &AppHandle,
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let job_definition_id = payload_string(payload, "jobDefinitionId")
        .ok_or_else(|| "jobDefinitionId is required".to_string())?;
    let reason = payload_string(payload, "reason")
        .unwrap_or_else(|| "Cancelled by task control".to_string());

    let result = with_store_mut(state, |store| {
        let definition = store
            .redclaw_job_definitions
            .iter()
            .find(|item| item.id == job_definition_id)
            .cloned()
            .ok_or_else(|| "任务定义不存在".to_string())?;
        if definition.requires_confirmation {
            store
                .redclaw_job_definitions
                .retain(|item| item.id != job_definition_id);
            return Ok(json!({
                "cancelled": true,
                "jobDefinitionId": job_definition_id,
                "draft": true,
            }));
        }

        match definition.source_kind.as_deref() {
            Some("scheduled") => {
                if let Some(task) = store
                    .redclaw_state
                    .scheduled_tasks
                    .iter_mut()
                    .find(|item| definition.source_task_id.as_deref() == Some(item.id.as_str()))
                {
                    task.enabled = false;
                    task.last_error = Some(reason.clone());
                    task.updated_at = now_iso();
                }
            }
            Some("long_cycle") => {
                if let Some(task) = store
                    .redclaw_state
                    .long_cycle_tasks
                    .iter_mut()
                    .find(|item| definition.source_task_id.as_deref() == Some(item.id.as_str()))
                {
                    task.enabled = false;
                    task.status = "paused".to_string();
                    task.last_error = Some(reason.clone());
                    task.updated_at = now_iso();
                }
            }
            _ => {}
        }

        if let Some(source_task_id) = definition.source_task_id.clone() {
            let _ = cancel_job_execution(store, &source_task_id, &reason);
        }
        sync_redclaw_job_definitions(store);
        Ok(json!({
            "cancelled": true,
            "jobDefinitionId": job_definition_id,
            "reason": reason,
        }))
    })?;

    emit_runtime_task_checkpoint_saved(
        app,
        Some(&job_definition_id),
        None,
        "task.cancelled",
        "Task definition cancelled",
        Some(result.clone()),
    );
    emit_scheduler_snapshot(app, state);
    Ok(json!({ "success": true, "result": result }))
}

pub fn handle_task_list(state: &State<'_, AppState>, payload: &Value) -> Result<Value, String> {
    let owner_scope_filter = payload_string(payload, "ownerScope");
    let include_drafts = payload_field(payload, "includeDrafts")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    with_store(state, |store| {
        let items = store
            .redclaw_job_definitions
            .iter()
            .filter(|item| include_drafts || !item.requires_confirmation)
            .filter(|item| {
                owner_scope_filter
                    .as_deref()
                    .map(|scope| item.owner_scope.as_deref() == Some(scope))
                    .unwrap_or(true)
            })
            .map(|definition| task_list_item(&store, definition))
            .collect::<Vec<_>>();
        Ok(json!({
            "success": true,
            "items": items,
            "count": items.len(),
        }))
    })
}

pub fn handle_task_stats(state: &State<'_, AppState>) -> Result<Value, String> {
    with_store(state, |store| {
        let definitions = &store.redclaw_job_definitions;
        let executions = &store.redclaw_job_executions;
        let draft_count = definitions
            .iter()
            .filter(|item| item.requires_confirmation)
            .count();
        let active_count = definitions
            .iter()
            .filter(|item| !item.requires_confirmation && item.enabled)
            .count();
        let recent = executions
            .iter()
            .filter(|item| item.archived_at.is_none())
            .take(12)
            .map(|item| {
                json!({
                    "executionId": item.id,
                    "runId": item.run_id,
                    "definitionId": item.definition_id,
                    "status": item.status,
                    "scheduledForAt": item.scheduled_for_at,
                    "attemptNo": item.attempt_no,
                    "retryBucket": item.retry_bucket,
                    "lastError": item.last_error,
                })
            })
            .collect::<Vec<_>>();
        Ok(json!({
            "success": true,
            "definitions": {
                "total": definitions.len(),
                "drafts": draft_count,
                "active": active_count,
            },
            "executions": {
                "total": executions.len(),
                "running": executions.iter().filter(|item| matches!(item.status.as_str(), "queued" | "leased" | "running" | "retrying")).count(),
                "failed": executions.iter().filter(|item| matches!(item.status.as_str(), "failed" | "dead_lettered")).count(),
                "recent": recent,
            }
        }))
    })
}

fn parse_task_intent(payload: &Value) -> Result<TaskIntentSchema, String> {
    let mut root = payload_field(payload, "intent").unwrap_or(payload).clone();
    if let Some(object) = root.as_object_mut() {
        if object.get("cron").is_none() {
            if let Some(value) = object.get("schedule").cloned() {
                object.insert("cron".to_string(), value);
            }
        }
        if object.get("goal").is_none() {
            if let Some(value) = object.get("description").cloned() {
                object.insert("goal".to_string(), value);
            }
        }
        if object.get("prompt").is_none() {
            if let Some(value) = object.get("message").cloned() {
                object.insert("prompt".to_string(), value);
            } else if let Some(value) = object.get("description").cloned() {
                object.insert("prompt".to_string(), value);
            }
        }
        if object.get("actionType").is_none() {
            if let Some(value) = object.get("type").cloned() {
                object.insert("actionType".to_string(), value);
            }
        }
    }
    let mut intent: TaskIntentSchema =
        serde_json::from_value(root).map_err(|error| format!("invalid task intent: {error}"))?;
    if intent.kind.trim().is_empty() {
        intent.kind = if intent.objective.is_some() || intent.step_prompt.is_some() {
            "long_cycle".to_string()
        } else {
            "scheduled".to_string()
        };
    }
    if intent.name.trim().is_empty() {
        intent.name = if intent.kind == "long_cycle" {
            "长周期任务".to_string()
        } else {
            "定时任务".to_string()
        };
    }
    if intent.owner_scope.trim().is_empty() {
        intent.owner_scope = "manual:redclaw".to_string();
    }
    if intent.action_type.trim().is_empty() {
        intent.action_type = if intent.kind == "long_cycle" {
            "long_cycle".to_string()
        } else {
            "redclaw_prompt".to_string()
        };
    }
    if intent.kind == "long_cycle" {
        if intent
            .objective
            .as_deref()
            .unwrap_or_default()
            .trim()
            .is_empty()
        {
            return Err("long_cycle 需要 objective".to_string());
        }
        if intent
            .step_prompt
            .as_deref()
            .unwrap_or_default()
            .trim()
            .is_empty()
        {
            return Err("long_cycle 需要 stepPrompt".to_string());
        }
    } else if intent
        .prompt
        .as_deref()
        .unwrap_or_default()
        .trim()
        .is_empty()
        && intent.goal.as_deref().unwrap_or_default().trim().is_empty()
    {
        return Err("scheduled 任务至少需要 prompt 或 goal".to_string());
    }
    Ok(intent)
}

#[cfg(test)]
mod tests {
    use super::parse_task_intent;
    use serde_json::json;

    #[test]
    fn parse_task_intent_accepts_common_preview_aliases() {
        let intent = parse_task_intent(&json!({
            "name": "晚间问候",
            "schedule": "45 21 * * *",
            "description": "每天晚上 9:45 向用户发送问候消息",
            "type": "greeting",
            "ownerScope": "manual:redclaw",
        }))
        .expect("aliases should normalize into a valid scheduled task intent");

        assert_eq!(intent.kind, "scheduled");
        assert_eq!(intent.cron.as_deref(), Some("45 21 * * *"));
        assert_eq!(
            intent.goal.as_deref(),
            Some("每天晚上 9:45 向用户发送问候消息")
        );
        assert_eq!(
            intent.prompt.as_deref(),
            Some("每天晚上 9:45 向用户发送问候消息")
        );
        assert_eq!(intent.action_type, "greeting");
    }
}

fn build_draft_definition(
    intent: &TaskIntentSchema,
    preview: &TaskPreviewResult,
) -> RedclawJobDefinitionRecord {
    let now = now_iso();
    let draft_id = make_id("taskdraft");
    let mut payload = Map::new();
    payload.insert(
        "intent".to_string(),
        serde_json::to_value(intent).unwrap_or(Value::Null),
    );
    payload.insert(
        "normalized".to_string(),
        serde_json::to_value(&preview.normalized).unwrap_or(Value::Null),
    );
    payload.insert("previewRunAt".to_string(), json!(preview.preview_run_at));
    payload.insert("policyDecision".to_string(), json!(preview.policy_decision));
    payload.insert("policyWarnings".to_string(), json!(preview.policy_warnings));
    payload.insert(
        "rejectionReasons".to_string(),
        json!(preview.rejection_reasons),
    );
    payload.insert("conflictTasks".to_string(), json!(preview.conflict_tasks));
    payload.insert("actionType".to_string(), json!(intent.action_type));
    payload.insert(
        "taskContractVersion".to_string(),
        json!(task_contract_version()),
    );
    payload.insert("draftState".to_string(), json!("pending"));
    RedclawJobDefinitionRecord {
        id: draft_id.clone(),
        source_kind: None,
        source_task_id: None,
        kind: if preview.normalized.kind == "long_cycle" {
            TASK_DRAFT_KIND_LONG_CYCLE.to_string()
        } else {
            TASK_DRAFT_KIND_SCHEDULED.to_string()
        },
        title: intent.name.clone(),
        enabled: false,
        owner_context_id: Some(intent.owner_scope.clone()),
        runtime_mode: "redclaw".to_string(),
        trigger_kind: preview.normalized.mode.clone(),
        progression_kind: preview.normalized.progression_kind.clone(),
        payload: Value::Object(payload),
        next_due_at: Some(preview.preview_run_at.clone()),
        last_enqueued_at: None,
        definition_fingerprint: Some(preview.definition_fingerprint.clone()),
        task_contract_version: Some(task_contract_version().to_string()),
        agent_intent_ref: Some(intent.intent.clone()),
        policy_signature: Some(preview.policy_signature.clone()),
        owner_scope: Some(intent.owner_scope.clone()),
        created_by: intent
            .created_by
            .clone()
            .or_else(|| Some("task-control".to_string())),
        creator_mode: intent
            .creator_mode
            .clone()
            .or_else(|| Some("redclaw".to_string())),
        requires_confirmation: true,
        draft_id: Some(draft_id),
        timezone: Some(
            intent
                .timezone
                .clone()
                .unwrap_or_else(|| "local".to_string()),
        ),
        missed_run_policy: Some(preview.normalized.missed_run_policy.clone()),
        created_at: now.clone(),
        updated_at: now,
    }
}

fn promote_draft_definition(
    store: &mut crate::AppStore,
    draft: &RedclawJobDefinitionRecord,
    intent: &TaskIntentSchema,
    preview: &TaskPreviewResult,
) -> Result<RedclawJobDefinitionRecord, String> {
    let now = now_iso();
    let prompt = intent
        .prompt
        .clone()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| intent.goal.clone())
        .unwrap_or_default();

    let source_key = if preview.normalized.kind == "long_cycle" {
        let task_id = make_id("long-cycle");
        store
            .redclaw_state
            .long_cycle_tasks
            .push(RedclawLongCycleTaskRecord {
                id: task_id.clone(),
                name: intent.name.clone(),
                enabled: true,
                status: "running".to_string(),
                objective: intent.objective.clone().unwrap_or_default(),
                step_prompt: intent.step_prompt.clone().unwrap_or_default(),
                project_id: None,
                interval_minutes: preview.normalized.interval_minutes.unwrap_or(720),
                total_rounds: preview.normalized.total_rounds.unwrap_or(12).max(1),
                completed_rounds: 0,
                created_at: now.clone(),
                updated_at: now.clone(),
                last_run_at: None,
                last_result: None,
                last_error: None,
                next_run_at: Some(preview.normalized.next_due_at.clone()),
            });
        ("long_cycle".to_string(), task_id)
    } else {
        let task_id = make_id("scheduled");
        store
            .redclaw_state
            .scheduled_tasks
            .push(RedclawScheduledTaskRecord {
                id: task_id.clone(),
                name: intent.name.clone(),
                enabled: true,
                mode: preview.normalized.mode.clone(),
                prompt,
                project_id: None,
                interval_minutes: preview.normalized.interval_minutes,
                time: normalize_optional_string(preview.normalized.time.clone()),
                weekdays: preview.normalized.weekdays.clone(),
                run_at: normalize_optional_string(preview.normalized.run_at.clone()),
                created_at: now.clone(),
                updated_at: now.clone(),
                last_run_at: None,
                last_result: None,
                last_error: None,
                next_run_at: Some(preview.normalized.next_due_at.clone()),
            });
        ("scheduled".to_string(), task_id)
    };

    sync_redclaw_job_definitions(store);
    let definition = store
        .redclaw_job_definitions
        .iter_mut()
        .find(|item| {
            item.source_kind.as_deref() == Some(source_key.0.as_str())
                && item.source_task_id.as_deref() == Some(source_key.1.as_str())
        })
        .ok_or_else(|| "新建任务定义同步失败".to_string())?;

    definition.definition_fingerprint = draft.definition_fingerprint.clone();
    definition.task_contract_version = draft.task_contract_version.clone();
    definition.agent_intent_ref = draft.agent_intent_ref.clone();
    definition.policy_signature = draft.policy_signature.clone();
    definition.owner_scope = draft.owner_scope.clone();
    definition.created_by = draft.created_by.clone();
    definition.creator_mode = draft.creator_mode.clone();
    definition.requires_confirmation = false;
    definition.draft_id = draft.draft_id.clone();
    definition.timezone = draft.timezone.clone();
    definition.missed_run_policy = draft.missed_run_policy.clone();
    definition.updated_at = now;
    definition.payload = merge_definition_payload(&definition.payload, draft, intent, preview);
    Ok(definition.clone())
}

fn merge_definition_payload(
    base: &Value,
    draft: &RedclawJobDefinitionRecord,
    intent: &TaskIntentSchema,
    preview: &TaskPreviewResult,
) -> Value {
    let mut merged = base.as_object().cloned().unwrap_or_default();
    merged.insert("actionType".to_string(), json!(intent.action_type));
    merged.insert("goal".to_string(), json!(intent.goal));
    merged.insert("objective".to_string(), json!(intent.objective));
    merged.insert("stepPrompt".to_string(), json!(intent.step_prompt));
    merged.insert("riskRationale".to_string(), json!(intent.risk_rationale));
    merged.insert("metadata".to_string(), json!(intent.metadata));
    merged.insert("ownerScope".to_string(), json!(intent.owner_scope));
    merged.insert("policyDecision".to_string(), json!(preview.policy_decision));
    merged.insert("policyWarnings".to_string(), json!(preview.policy_warnings));
    merged.insert(
        "taskContractVersion".to_string(),
        json!(task_contract_version()),
    );
    merged.insert(
        "draftId".to_string(),
        json!(draft.draft_id.clone().unwrap_or_else(|| draft.id.clone())),
    );
    Value::Object(merged)
}

fn intent_from_definition(
    store: &crate::AppStore,
    definition: &RedclawJobDefinitionRecord,
) -> Result<TaskIntentSchema, String> {
    if definition.requires_confirmation {
        return parse_task_intent(
            definition
                .payload
                .get("intent")
                .ok_or_else(|| "草稿缺少 intent".to_string())?,
        );
    }
    match definition.source_kind.as_deref() {
        Some("scheduled") => {
            let task = store
                .redclaw_state
                .scheduled_tasks
                .iter()
                .find(|item| definition.source_task_id.as_deref() == Some(item.id.as_str()))
                .ok_or_else(|| "定时任务源记录不存在".to_string())?;
            Ok(TaskIntentSchema {
                kind: "scheduled".to_string(),
                intent: definition.agent_intent_ref.clone().unwrap_or_default(),
                name: task.name.clone(),
                goal: definition
                    .payload
                    .get("goal")
                    .and_then(Value::as_str)
                    .map(|value| value.to_string()),
                action_type: definition
                    .payload
                    .get("actionType")
                    .and_then(Value::as_str)
                    .unwrap_or("redclaw_prompt")
                    .to_string(),
                owner_scope: definition
                    .owner_scope
                    .clone()
                    .unwrap_or_else(|| "manual:redclaw".to_string()),
                timezone: definition.timezone.clone(),
                missed_run_policy: definition.missed_run_policy.clone(),
                creator_mode: definition.creator_mode.clone(),
                created_by: definition.created_by.clone(),
                risk_rationale: definition
                    .payload
                    .get("riskRationale")
                    .and_then(Value::as_str)
                    .map(|value| value.to_string()),
                prompt: Some(task.prompt.clone()),
                mode: Some(task.mode.clone()),
                interval_minutes: task.interval_minutes,
                time: task.time.clone(),
                weekdays: task.weekdays.clone(),
                run_at: task.run_at.clone(),
                metadata: definition.payload.get("metadata").cloned(),
                ..TaskIntentSchema::default()
            })
        }
        Some("long_cycle") => {
            let task = store
                .redclaw_state
                .long_cycle_tasks
                .iter()
                .find(|item| definition.source_task_id.as_deref() == Some(item.id.as_str()))
                .ok_or_else(|| "长周期任务源记录不存在".to_string())?;
            Ok(TaskIntentSchema {
                kind: "long_cycle".to_string(),
                intent: definition.agent_intent_ref.clone().unwrap_or_default(),
                name: task.name.clone(),
                action_type: definition
                    .payload
                    .get("actionType")
                    .and_then(Value::as_str)
                    .unwrap_or("long_cycle")
                    .to_string(),
                owner_scope: definition
                    .owner_scope
                    .clone()
                    .unwrap_or_else(|| "manual:redclaw".to_string()),
                timezone: definition.timezone.clone(),
                missed_run_policy: definition.missed_run_policy.clone(),
                creator_mode: definition.creator_mode.clone(),
                created_by: definition.created_by.clone(),
                risk_rationale: definition
                    .payload
                    .get("riskRationale")
                    .and_then(Value::as_str)
                    .map(|value| value.to_string()),
                objective: Some(task.objective.clone()),
                step_prompt: Some(task.step_prompt.clone()),
                interval_minutes: Some(task.interval_minutes),
                total_rounds: Some(task.total_rounds),
                metadata: definition.payload.get("metadata").cloned(),
                ..TaskIntentSchema::default()
            })
        }
        _ => Err("当前任务定义没有可更新的 source".to_string()),
    }
}

fn merge_patch_into_intent(intent: &mut TaskIntentSchema, patch: &Value) -> Result<(), String> {
    if !patch.is_object() {
        return Err("patch 必须是对象".to_string());
    }
    if let Some(value) = payload_string(patch, "name") {
        intent.name = value;
    }
    if let Some(value) = payload_string(patch, "cron") {
        intent.cron = Some(value);
    }
    if let Some(value) = payload_string(patch, "goal") {
        intent.goal = Some(value);
    }
    if let Some(value) = payload_string(patch, "prompt") {
        intent.prompt = Some(value);
    }
    if let Some(value) = payload_string(patch, "objective") {
        intent.objective = Some(value);
    }
    if let Some(value) = payload_string(patch, "stepPrompt") {
        intent.step_prompt = Some(value);
    }
    if let Some(value) = payload_string(patch, "actionType") {
        intent.action_type = value;
    }
    if let Some(value) = payload_string(patch, "ownerScope") {
        intent.owner_scope = value;
    }
    if let Some(value) = payload_string(patch, "mode") {
        intent.mode = Some(value);
    }
    if let Some(value) = payload_string(patch, "timezone") {
        intent.timezone = Some(value);
    }
    if let Some(value) = payload_string(patch, "time") {
        intent.time = Some(value);
    }
    if let Some(value) = payload_string(patch, "runAt") {
        intent.run_at = Some(value);
    }
    if let Some(value) = payload_field(patch, "intervalMinutes").and_then(Value::as_i64) {
        intent.interval_minutes = Some(value);
    }
    if let Some(value) = payload_field(patch, "totalRounds").and_then(Value::as_i64) {
        intent.total_rounds = Some(value);
    }
    if let Some(items) = payload_field(patch, "weekdays").and_then(Value::as_array) {
        intent.weekdays = Some(items.iter().filter_map(Value::as_i64).collect());
    }
    if let Some(value) = payload_string(patch, "missedRunPolicy") {
        intent.missed_run_policy = Some(value);
    }
    if let Some(value) = payload_string(patch, "riskRationale") {
        intent.risk_rationale = Some(value);
    }
    if let Some(value) = payload_field(patch, "metadata") {
        intent.metadata = Some(value.clone());
    }
    Ok(())
}

fn apply_intent_update(
    store: &mut crate::AppStore,
    definition: &RedclawJobDefinitionRecord,
    intent: &TaskIntentSchema,
    preview: &TaskPreviewResult,
    reason: &str,
) -> Result<(), String> {
    match definition.source_kind.as_deref() {
        Some("scheduled") => {
            let task = store
                .redclaw_state
                .scheduled_tasks
                .iter_mut()
                .find(|item| definition.source_task_id.as_deref() == Some(item.id.as_str()))
                .ok_or_else(|| "定时任务源记录不存在".to_string())?;
            task.name = intent.name.clone();
            task.prompt = intent
                .prompt
                .clone()
                .or_else(|| intent.goal.clone())
                .unwrap_or_default();
            task.mode = preview.normalized.mode.clone();
            task.interval_minutes = preview.normalized.interval_minutes;
            task.time = normalize_optional_string(preview.normalized.time.clone());
            task.weekdays = preview.normalized.weekdays.clone();
            task.run_at = normalize_optional_string(preview.normalized.run_at.clone());
            task.next_run_at = Some(preview.normalized.next_due_at.clone());
            task.updated_at = now_iso();
        }
        Some("long_cycle") => {
            let task = store
                .redclaw_state
                .long_cycle_tasks
                .iter_mut()
                .find(|item| definition.source_task_id.as_deref() == Some(item.id.as_str()))
                .ok_or_else(|| "长周期任务源记录不存在".to_string())?;
            task.name = intent.name.clone();
            task.objective = intent.objective.clone().unwrap_or_default();
            task.step_prompt = intent.step_prompt.clone().unwrap_or_default();
            task.interval_minutes = preview
                .normalized
                .interval_minutes
                .unwrap_or(task.interval_minutes);
            task.total_rounds = preview.normalized.total_rounds.unwrap_or(task.total_rounds);
            task.next_run_at = Some(preview.normalized.next_due_at.clone());
            task.updated_at = now_iso();
        }
        _ => return Err("当前任务定义没有可更新的 source".to_string()),
    }

    sync_redclaw_job_definitions(store);
    if let Some(updated) = store
        .redclaw_job_definitions
        .iter_mut()
        .find(|item| item.id == definition.id)
    {
        clear_definition_cooldown(updated);
        updated.definition_fingerprint = Some(preview.definition_fingerprint.clone());
        updated.policy_signature = Some(preview.policy_signature.clone());
        updated.owner_scope = Some(intent.owner_scope.clone());
        updated.created_by = intent.created_by.clone();
        updated.creator_mode = intent.creator_mode.clone();
        updated.timezone = Some(
            intent
                .timezone
                .clone()
                .unwrap_or_else(|| "local".to_string()),
        );
        updated.missed_run_policy = Some(preview.normalized.missed_run_policy.clone());
        updated.updated_at = now_iso();
        if let Some(object) = updated.payload.as_object_mut() {
            object.insert("actionType".to_string(), json!(intent.action_type));
            object.insert("goal".to_string(), json!(intent.goal));
            object.insert("objective".to_string(), json!(intent.objective));
            object.insert("stepPrompt".to_string(), json!(intent.step_prompt));
            object.insert("riskRationale".to_string(), json!(intent.risk_rationale));
            object.insert("metadata".to_string(), json!(intent.metadata));
            object.insert("policyDecision".to_string(), json!(preview.policy_decision));
            object.insert("policyWarnings".to_string(), json!(preview.policy_warnings));
            object.insert("lastUpdatedReason".to_string(), json!(reason));
        }
    }
    Ok(())
}

fn task_list_item(store: &crate::AppStore, definition: &RedclawJobDefinitionRecord) -> Value {
    let latest_execution = store
        .redclaw_job_executions
        .iter()
        .filter(|item| item.definition_id == definition.id)
        .max_by(|left, right| left.updated_at.cmp(&right.updated_at));
    json!({
        "definitionId": definition.id,
        "title": definition.title,
        "kind": definition.kind,
        "sourceKind": definition.source_kind,
        "sourceTaskId": definition.source_task_id,
        "enabled": definition.enabled,
        "ownerScope": definition.owner_scope,
        "createdBy": definition.created_by,
        "creatorMode": definition.creator_mode,
        "requiresConfirmation": definition.requires_confirmation,
        "policySignature": definition.policy_signature,
        "definitionFingerprint": definition.definition_fingerprint,
        "triggerKind": definition.trigger_kind,
        "progressionKind": definition.progression_kind,
        "nextDueAt": definition.next_due_at,
        "draftId": definition.draft_id,
        "timezone": definition.timezone,
        "missedRunPolicy": definition.missed_run_policy,
        "cooldown": definition.payload.get("cooldown"),
        "policyDecision": definition.payload.get("policyDecision"),
        "policyWarnings": definition.payload.get("policyWarnings"),
        "actionType": definition.payload.get("actionType"),
        "goal": definition.payload.get("goal"),
        "prompt": definition.payload.get("prompt"),
        "objective": definition.payload.get("objective"),
        "stepPrompt": definition.payload.get("stepPrompt"),
        "riskRationale": definition.payload.get("riskRationale"),
        "totalRounds": definition.payload.get("totalRounds"),
        "completedRounds": definition.payload.get("completedRounds"),
        "lastUpdatedReason": definition.payload.get("lastUpdatedReason"),
        "latestExecution": latest_execution.map(|item| {
            json!({
                "executionId": item.id,
                "runId": item.run_id,
                "status": item.status,
                "scheduledForAt": item.scheduled_for_at,
                "attemptNo": item.attempt_no,
                "retryBucket": item.retry_bucket,
                "lastHeartbeatAt": item.last_heartbeat_at,
                "lastError": item.last_error,
                "updatedAt": item.updated_at,
            })
        }),
        "updatedAt": definition.updated_at,
        "createdAt": definition.created_at,
    })
}
