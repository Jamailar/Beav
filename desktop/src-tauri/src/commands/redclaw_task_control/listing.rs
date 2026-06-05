use serde_json::{json, Value};
use tauri::State;

use crate::persistence::with_store;
use crate::runtime::{RedclawJobDefinitionRecord, RedclawJobExecutionRecord};
use crate::store::redclaw as redclaw_store;
use crate::{payload_field, payload_string, AppState};

pub fn handle_task_list(state: &State<'_, AppState>, payload: &Value) -> Result<Value, String> {
    let owner_scope_filter = payload_string(payload, "ownerScope");
    let include_drafts = payload_field(payload, "includeDrafts")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    with_store(state, |store| {
        let executions = redclaw_store::list_job_executions(&store);
        let items = redclaw_store::list_job_definitions(&store)
            .iter()
            .filter(|item| include_drafts || !item.requires_confirmation)
            .filter(|item| {
                owner_scope_filter
                    .as_deref()
                    .map(|scope| item.owner_scope.as_deref() == Some(scope))
                    .unwrap_or(true)
            })
            .map(|definition| task_list_item(&executions, definition))
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
        let definitions = redclaw_store::list_job_definitions(&store);
        let executions = redclaw_store::list_job_executions(&store);
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

fn task_list_item(
    executions: &[RedclawJobExecutionRecord],
    definition: &RedclawJobDefinitionRecord,
) -> Value {
    let latest_execution = executions
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
        "intervalMinutes": definition.payload.get("intervalMinutes"),
        "time": definition.payload.get("time"),
        "weekdays": definition.payload.get("weekdays"),
        "runAt": definition.payload.get("runAt"),
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
