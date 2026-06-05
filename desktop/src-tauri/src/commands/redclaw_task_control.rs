#[path = "redclaw_task_control/listing.rs"]
mod listing;

use serde_json::{json, Map, Value};
use tauri::{AppHandle, State};

use crate::events::{emit_runtime_event, emit_runtime_task_checkpoint_saved};
use crate::persistence::{with_store, with_store_mut};
use crate::runtime::{
    create_review_docket, RedclawJobDefinitionRecord, RedclawLongCycleTaskRecord,
    RedclawScheduledTaskRecord,
};
use crate::scheduler::task_policy::{
    preview_task_intent, task_contract_version, TaskIntentSchema, TaskPolicyDecisionKind,
    TaskPreviewResult,
};
use crate::scheduler::{
    cancel_job_execution, clear_definition_cooldown, emit_scheduler_snapshot,
    sync_redclaw_job_definitions,
};
use crate::store::redclaw as redclaw_store;
use crate::{
    make_id, normalize_optional_string, now_i64, now_iso, payload_field, payload_string, AppState,
};
pub use listing::{handle_task_list, handle_task_stats};

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
        if let Some(existing) = redclaw_store::find_confirmable_job_definition(
            store,
            &intent.owner_scope,
            &preview.definition_fingerprint,
        ) {
            return Ok(json!({
                "draftId": existing.id,
                "definition": existing,
                "created": false,
                "preview": preview,
            }));
        }

        let draft = build_draft_definition(&intent, &preview);
        redclaw_store::push_job_definition(store, draft.clone());
        let review_docket_id =
            maybe_create_review_docket_for_draft(store, &draft, &intent, &preview)?;
        Ok(json!({
            "draftId": draft.id,
            "definition": draft,
            "created": true,
            "preview": preview,
            "reviewDocketId": review_docket_id,
        }))
    })?;
    if let Some(docket_id) = created.get("reviewDocketId").and_then(Value::as_str) {
        emit_runtime_event(
            app,
            "runtime:review-docket-changed",
            None,
            None,
            json!({ "docketId": docket_id, "sourceKind": "redclaw_task_draft" }),
        );
    }

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
        let draft = redclaw_store::job_definition_by_id(store, &draft_id)
            .filter(|item| item.requires_confirmation)
            .ok_or_else(|| "任务草稿不存在".to_string())?;

        if !confirm {
            mark_review_dockets_for_draft(store, &draft_id, "rejected");
            redclaw_store::remove_job_definition(store, &draft_id);
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
        let mut preview_store = store.clone();
        redclaw_store::remove_job_definition(&mut preview_store, &draft_id);
        let preview = preview_task_intent(&preview_store, &intent, now_i64())?;
        if matches!(preview.policy_decision, TaskPolicyDecisionKind::Reject) {
            return Err(preview
                .rejection_reasons
                .first()
                .cloned()
                .unwrap_or_else(|| "任务策略拒绝确认".to_string()));
        }

        let definition = promote_draft_definition(store, &draft, &intent, &preview)?;
        mark_review_dockets_for_draft(store, &draft_id, "approved");
        redclaw_store::remove_job_definition(store, &draft_id);
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

pub fn handle_task_cancel(
    app: &AppHandle,
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let job_definition_id = payload_string(payload, "jobDefinitionId")
        .or_else(|| payload_string(payload, "draftId"))
        .ok_or_else(|| "jobDefinitionId is required".to_string())?;
    let reason = payload_string(payload, "reason")
        .unwrap_or_else(|| "Cancelled by task control".to_string());
    let delete_source = payload_field(payload, "deleteSource")
        .and_then(Value::as_bool)
        .unwrap_or(false);

    let result = with_store_mut(state, |store| {
        let definition = redclaw_store::job_definition_by_id(store, &job_definition_id)
            .ok_or_else(|| "任务定义不存在".to_string())?;
        if definition.requires_confirmation {
            redclaw_store::remove_job_definition(store, &job_definition_id);
            return Ok(json!({
                "cancelled": true,
                "jobDefinitionId": job_definition_id,
                "draft": true,
            }));
        }

        if delete_source {
            redclaw_store::remove_source_task_for_definition(store, &definition);
            if let Some(source_task_id) = definition.source_task_id.clone() {
                let _ = cancel_job_execution(store, &source_task_id, &reason);
            }
            sync_redclaw_job_definitions(store);
            return Ok(json!({
                "cancelled": true,
                "deleted": true,
                "jobDefinitionId": job_definition_id,
                "reason": reason,
            }));
        }

        redclaw_store::pause_source_task_for_definition(store, &definition, &reason, &now_iso());

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

fn parse_task_intent(payload: &Value) -> Result<TaskIntentSchema, String> {
    let mut root = payload
        .get("intent")
        .filter(|value| value.is_object())
        .cloned()
        .unwrap_or_else(|| payload.clone());
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
    use super::{
        build_draft_definition, mark_review_dockets_for_draft,
        maybe_create_review_docket_for_draft, parse_task_intent,
        should_create_review_docket_for_draft,
    };
    use crate::scheduler::task_policy::preview_task_intent;
    use crate::{now_i64, AppStore};
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

    #[test]
    fn parse_task_intent_accepts_raw_task_intent_objects() {
        let intent = parse_task_intent(&json!({
            "intent": "",
            "name": "晚间问候",
            "cron": "25 20 * * *",
            "prompt": "每天晚上 20:25 和我打招呼",
            "actionType": "greeting",
            "ownerScope": "manual:redclaw",
        }))
        .expect("raw task intent objects should not be mistaken for wrapped payloads");

        assert_eq!(intent.name, "晚间问候");
        assert_eq!(intent.cron.as_deref(), Some("25 20 * * *"));
        assert_eq!(intent.prompt.as_deref(), Some("每天晚上 20:25 和我打招呼"));
        assert_eq!(intent.action_type, "greeting");
    }

    #[test]
    fn redclaw_non_manual_draft_creates_review_docket() {
        let mut store = AppStore::default();
        let intent = parse_task_intent(&json!({
            "name": "AI 自动巡检",
            "cron": "0 9 * * *",
            "prompt": "每天检查素材库异常并总结。",
            "actionType": "redclaw_prompt",
            "ownerScope": "agent:redclaw",
            "creatorMode": "redclaw_auto",
            "createdBy": "redclaw-agent",
        }))
        .unwrap();
        let preview = preview_task_intent(&store, &intent, now_i64()).unwrap();
        let draft = build_draft_definition(&intent, &preview);

        assert!(should_create_review_docket_for_draft(&intent));
        let docket_id = maybe_create_review_docket_for_draft(&mut store, &draft, &intent, &preview)
            .unwrap()
            .expect("non-manual draft should create a docket");

        let docket = store
            .review_dockets
            .iter()
            .find(|item| item.id == docket_id)
            .unwrap();
        assert_eq!(docket.source_kind, "redclaw_task_draft");
        assert_eq!(docket.source_id.as_deref(), Some(draft.id.as_str()));
        assert_eq!(docket.status, "pending");

        mark_review_dockets_for_draft(&mut store, &draft.id, "approved");
        let docket = store
            .review_dockets
            .iter()
            .find(|item| item.id == docket_id)
            .unwrap();
        assert_eq!(docket.status, "approved");
        assert!(docket.decided_at.is_some());
    }

    #[test]
    fn redclaw_manual_draft_does_not_create_review_docket() {
        let mut store = AppStore::default();
        let intent = parse_task_intent(&json!({
            "name": "手动任务",
            "cron": "0 9 * * *",
            "prompt": "每天整理一次素材。",
            "actionType": "redclaw_prompt",
            "ownerScope": "manual:redclaw",
            "creatorMode": "ui-manual",
            "createdBy": "redclaw-task-center",
        }))
        .unwrap();
        let preview = preview_task_intent(&store, &intent, now_i64()).unwrap();
        let draft = build_draft_definition(&intent, &preview);

        assert!(!should_create_review_docket_for_draft(&intent));
        let docket_id =
            maybe_create_review_docket_for_draft(&mut store, &draft, &intent, &preview).unwrap();

        assert!(docket_id.is_none());
        assert!(store.review_dockets.is_empty());
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

fn should_create_review_docket_for_draft(intent: &TaskIntentSchema) -> bool {
    let creator_mode = intent.creator_mode.as_deref().unwrap_or_default();
    let created_by = intent.created_by.as_deref().unwrap_or_default();
    creator_mode != "ui-manual" && created_by != "redclaw-task-center"
}

fn maybe_create_review_docket_for_draft(
    store: &mut crate::AppStore,
    draft: &RedclawJobDefinitionRecord,
    intent: &TaskIntentSchema,
    preview: &TaskPreviewResult,
) -> Result<Option<String>, String> {
    if !should_create_review_docket_for_draft(intent) {
        return Ok(None);
    }
    if let Some(existing) = store.review_dockets.iter().find(|docket| {
        docket.source_kind == "redclaw_task_draft"
            && docket.source_id.as_deref() == Some(draft.id.as_str())
            && docket.status == "pending"
    }) {
        return Ok(Some(existing.id.clone()));
    }

    let docket = create_review_docket(
        store,
        &json!({
            "sourceKind": "redclaw_task_draft",
            "sourceId": draft.id,
            "title": draft.title,
            "summary": format!("RedClaw 请求创建 {}。", if preview.normalized.kind == "long_cycle" { "长周期任务" } else { "定时任务" }),
            "body": redclaw_draft_review_body(intent, preview),
            "decisionType": "redclaw_task_confirm",
            "priority": if matches!(&preview.policy_decision, TaskPolicyDecisionKind::RequireConfirm) { "high" } else { "normal" },
            "riskLevel": if preview.policy_warnings.is_empty() { "normal" } else { "medium" },
            "evidenceRefs": preview.conflict_tasks.iter().map(|item| json!({
                "kind": "conflict_task",
                "definitionId": item.definition_id,
                "title": item.title,
                "lifecycleState": item.lifecycle_state,
            })).collect::<Vec<_>>(),
            "proposedAction": {
                "kind": "redclaw_task_draft",
                "draftId": draft.id,
                "onDecisionConfirm": {
                    "approved": true,
                    "rejected": false
                }
            },
            "createdByAgentId": intent.created_by,
        }),
    )?;
    Ok(Some(docket.id))
}

fn redclaw_draft_review_body(intent: &TaskIntentSchema, preview: &TaskPreviewResult) -> String {
    let mut lines = Vec::new();
    lines.push(format!("名称：{}", intent.name));
    lines.push(format!("类型：{}", preview.normalized.kind));
    lines.push(format!("调度：{}", preview.normalized.preview_label));
    lines.push(format!("动作：{}", intent.action_type));
    lines.push(format!("Owner：{}", intent.owner_scope));
    if let Some(prompt) = intent
        .prompt
        .as_deref()
        .or(intent.goal.as_deref())
        .filter(|value| !value.trim().is_empty())
    {
        lines.push(format!("提示词：{prompt}"));
    }
    if let Some(objective) = intent
        .objective
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        lines.push(format!("目标：{objective}"));
    }
    if !preview.policy_warnings.is_empty() {
        lines.push(format!("策略提醒：{}", preview.policy_warnings.join("；")));
    }
    if !preview.conflict_tasks.is_empty() {
        lines.push(format!("相似任务：{} 个", preview.conflict_tasks.len()));
    }
    lines.join("\n")
}

fn mark_review_dockets_for_draft(store: &mut crate::AppStore, draft_id: &str, status: &str) {
    let now = now_i64();
    for docket in store.review_dockets.iter_mut().filter(|docket| {
        docket.source_kind == "redclaw_task_draft"
            && docket.source_id.as_deref() == Some(draft_id)
            && docket.status == "pending"
    }) {
        docket.status = status.to_string();
        docket.updated_at = now;
        docket.decided_at = Some(now);
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
        redclaw_store::push_long_cycle_task(
            store,
            RedclawLongCycleTaskRecord {
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
            },
        );
        ("long_cycle".to_string(), task_id)
    } else {
        let task_id = make_id("scheduled");
        redclaw_store::push_scheduled_task(
            store,
            RedclawScheduledTaskRecord {
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
            },
        );
        ("scheduled".to_string(), task_id)
    };

    sync_redclaw_job_definitions(store);
    redclaw_store::update_job_definition_by_source(
        store,
        &source_key.0,
        &source_key.1,
        |definition| {
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
            definition.payload =
                merge_definition_payload(&definition.payload, draft, intent, preview);
            definition.clone()
        },
    )
    .ok_or_else(|| "新建任务定义同步失败".to_string())
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
