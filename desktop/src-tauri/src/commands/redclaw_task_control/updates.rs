use serde_json::{json, Value};
use tauri::{AppHandle, State};

use super::parse_task_intent;
use crate::events::emit_runtime_task_checkpoint_saved;
use crate::persistence::with_store_mut;
use crate::runtime::RedclawJobDefinitionRecord;
use crate::scheduler::task_policy::{
    preview_task_intent, TaskIntentSchema, TaskPolicyDecisionKind, TaskPreviewResult,
};
use crate::scheduler::{
    clear_definition_cooldown, emit_scheduler_snapshot, sync_redclaw_job_definitions,
};
use crate::store::redclaw as redclaw_store;
use crate::{normalize_optional_string, now_i64, now_iso, payload_field, payload_string, AppState};

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
        let existing = redclaw_store::job_definition_by_id(store, &job_definition_id)
            .ok_or_else(|| "任务定义不存在".to_string())?;
        if existing.requires_confirmation {
            return Err("草稿任务请重新 preview/create/confirm，不支持直接 update".to_string());
        }
        let mut intent = intent_from_definition(store, &existing)?;
        merge_patch_into_intent(&mut intent, &patch)?;
        let mut preview_store = store.clone();
        redclaw_store::update_job_definition(
            &mut preview_store,
            &job_definition_id,
            |existing_definition| {
                clear_definition_cooldown(existing_definition);
            },
        );
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
        let updated = redclaw_store::job_definition_by_id(store, &job_definition_id)
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
            let task = redclaw_store::scheduled_task_for_definition(store, definition)
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
            let task = redclaw_store::long_cycle_task_for_definition(store, definition)
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
            redclaw_store::update_scheduled_task_for_definition(store, definition, |task| {
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
            })?;
        }
        Some("long_cycle") => {
            redclaw_store::update_long_cycle_task_for_definition(store, definition, |task| {
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
            })?;
        }
        _ => return Err("当前任务定义没有可更新的 source".to_string()),
    }

    sync_redclaw_job_definitions(store);
    redclaw_store::update_job_definition(store, &definition.id, |updated| {
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
    });
    Ok(())
}
