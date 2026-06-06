use serde_json::Value;

use crate::scheduler::task_policy::TaskIntentSchema;
use crate::{payload_field, payload_string};

pub(super) fn scheduled_task_intent_from_payload(payload: &Value) -> TaskIntentSchema {
    TaskIntentSchema {
        kind: "scheduled".to_string(),
        intent: "legacy-ui-direct".to_string(),
        name: payload_string(payload, "name").unwrap_or_else(|| "定时任务".to_string()),
        action_type: payload_string(payload, "actionType")
            .unwrap_or_else(|| "redclaw_prompt".to_string()),
        owner_scope: payload_string(payload, "ownerScope")
            .unwrap_or_else(|| "manual:redclaw".to_string()),
        timezone: Some(payload_string(payload, "timezone").unwrap_or_else(|| "local".to_string())),
        creator_mode: Some("ui-manual".to_string()),
        created_by: Some("redclaw-panel".to_string()),
        risk_rationale: payload_string(payload, "riskRationale"),
        prompt: payload_string(payload, "prompt"),
        mode: payload_string(payload, "mode"),
        interval_minutes: payload_field(payload, "intervalMinutes").and_then(Value::as_i64),
        time: payload_string(payload, "time"),
        weekdays: payload_field(payload, "weekdays")
            .and_then(Value::as_array)
            .map(|items| items.iter().filter_map(Value::as_i64).collect()),
        run_at: payload_string(payload, "runAt"),
        missed_run_policy: payload_string(payload, "missedRunPolicy"),
        metadata: payload_field(payload, "metadata").cloned(),
        ..TaskIntentSchema::default()
    }
}

pub(super) fn long_cycle_task_intent_from_payload(payload: &Value) -> TaskIntentSchema {
    TaskIntentSchema {
        kind: "long_cycle".to_string(),
        intent: "legacy-ui-direct".to_string(),
        name: payload_string(payload, "name").unwrap_or_else(|| "长周期任务".to_string()),
        action_type: payload_string(payload, "actionType")
            .unwrap_or_else(|| "long_cycle".to_string()),
        owner_scope: payload_string(payload, "ownerScope")
            .unwrap_or_else(|| "manual:redclaw".to_string()),
        timezone: Some(payload_string(payload, "timezone").unwrap_or_else(|| "local".to_string())),
        creator_mode: Some("ui-manual".to_string()),
        created_by: Some("redclaw-panel".to_string()),
        risk_rationale: payload_string(payload, "riskRationale"),
        objective: payload_string(payload, "objective"),
        step_prompt: payload_string(payload, "stepPrompt"),
        interval_minutes: payload_field(payload, "intervalMinutes").and_then(Value::as_i64),
        total_rounds: payload_field(payload, "totalRounds").and_then(Value::as_i64),
        missed_run_policy: payload_string(payload, "missedRunPolicy"),
        metadata: payload_field(payload, "metadata").cloned(),
        ..TaskIntentSchema::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn scheduled_task_intent_applies_legacy_ui_defaults() {
        let intent = scheduled_task_intent_from_payload(&json!({
            "name": "早报",
            "weekdays": [1, "bad", 5],
            "metadata": {"source": "test"}
        }));

        assert_eq!(intent.kind, "scheduled");
        assert_eq!(intent.intent, "legacy-ui-direct");
        assert_eq!(intent.name, "早报");
        assert_eq!(intent.action_type, "redclaw_prompt");
        assert_eq!(intent.owner_scope, "manual:redclaw");
        assert_eq!(intent.timezone.as_deref(), Some("local"));
        assert_eq!(intent.creator_mode.as_deref(), Some("ui-manual"));
        assert_eq!(intent.created_by.as_deref(), Some("redclaw-panel"));
        assert_eq!(intent.weekdays, Some(vec![1, 5]));
    }

    #[test]
    fn long_cycle_task_intent_keeps_objective_and_step_prompt() {
        let intent = long_cycle_task_intent_from_payload(&json!({
            "objective": "复盘",
            "stepPrompt": "分析一轮",
            "totalRounds": 3
        }));

        assert_eq!(intent.kind, "long_cycle");
        assert_eq!(intent.action_type, "long_cycle");
        assert_eq!(intent.name, "长周期任务");
        assert_eq!(intent.objective.as_deref(), Some("复盘"));
        assert_eq!(intent.step_prompt.as_deref(), Some("分析一轮"));
        assert_eq!(intent.total_rounds, Some(3));
    }
}
