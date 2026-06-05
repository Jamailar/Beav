use serde_json::{json, Map, Value};

use crate::runtime::{
    create_review_docket, RedclawJobDefinitionRecord, RedclawLongCycleTaskRecord,
    RedclawScheduledTaskRecord,
};
use crate::scheduler::sync_redclaw_job_definitions;
use crate::scheduler::task_policy::{
    task_contract_version, TaskIntentSchema, TaskPolicyDecisionKind, TaskPreviewResult,
};
use crate::store::redclaw as redclaw_store;
use crate::{make_id, normalize_optional_string, now_i64, now_iso};

const TASK_DRAFT_KIND_SCHEDULED: &str = "scheduled_draft";
const TASK_DRAFT_KIND_LONG_CYCLE: &str = "long_cycle_draft";

pub(super) fn build_draft_definition(
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

pub(super) fn should_create_review_docket_for_draft(intent: &TaskIntentSchema) -> bool {
    let creator_mode = intent.creator_mode.as_deref().unwrap_or_default();
    let created_by = intent.created_by.as_deref().unwrap_or_default();
    creator_mode != "ui-manual" && created_by != "redclaw-task-center"
}

pub(super) fn maybe_create_review_docket_for_draft(
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

pub(super) fn mark_review_dockets_for_draft(
    store: &mut crate::AppStore,
    draft_id: &str,
    status: &str,
) {
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

pub(super) fn promote_draft_definition(
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

#[cfg(test)]
mod tests {
    use super::super::parse_task_intent;
    use super::{
        build_draft_definition, mark_review_dockets_for_draft,
        maybe_create_review_docket_for_draft, should_create_review_docket_for_draft,
    };
    use crate::scheduler::task_policy::preview_task_intent;
    use crate::{now_i64, AppStore};
    use serde_json::json;

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
