#[path = "redclaw_task_control/cancel.rs"]
mod cancel;
#[path = "redclaw_task_control/drafts.rs"]
mod drafts;
#[path = "redclaw_task_control/listing.rs"]
mod listing;
#[path = "redclaw_task_control/updates.rs"]
mod updates;

use serde_json::{json, Value};
use tauri::{AppHandle, State};

use crate::events::{emit_runtime_event, emit_runtime_task_checkpoint_saved};
use crate::persistence::{with_store, with_store_mut};
use crate::scheduler::emit_scheduler_snapshot;
use crate::scheduler::task_policy::{
    preview_task_intent, TaskIntentSchema, TaskPolicyDecisionKind,
};
use crate::store::redclaw as redclaw_store;
use crate::{now_i64, payload_field, payload_string, AppState};
pub use cancel::handle_task_cancel;
use drafts::{
    build_draft_definition, mark_review_dockets_for_draft, maybe_create_review_docket_for_draft,
    promote_draft_definition,
};
pub use listing::{handle_task_list, handle_task_stats};
pub use updates::handle_task_update;

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

pub(super) fn parse_task_intent(payload: &Value) -> Result<TaskIntentSchema, String> {
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
}
