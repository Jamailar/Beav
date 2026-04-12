use serde_json::{json, Value};

use crate::subagents::SubAgentOutput;
use crate::{payload_string, AppStore};

fn fallback_summary(store: &AppStore, child_task_id: &str) -> Option<String> {
    store
        .runtime_tasks
        .iter()
        .find(|item| item.id == child_task_id)
        .and_then(|task| {
            task.checkpoints
                .iter()
                .rev()
                .find(|item| item.checkpoint_type == "subagent.output")
                .map(|item| item.summary.clone())
                .or_else(|| {
                    task.artifacts
                        .iter()
                        .rev()
                        .find(|item| item.artifact_type == "subagent-output")
                        .and_then(|artifact| {
                            artifact
                                .payload
                                .as_ref()
                                .and_then(|payload| payload_string(payload, "summary"))
                        })
                })
        })
}

pub fn build_orchestration_value(store: &AppStore, outputs: Vec<SubAgentOutput>) -> Value {
    let outputs = outputs
        .into_iter()
        .map(|item| {
            let summary = item
                .child_task_id
                .as_deref()
                .and_then(|task_id| fallback_summary(store, task_id))
                .unwrap_or_else(|| item.summary.clone());
            json!({
                "roleId": item.role_id,
                "summary": summary,
                "artifact": item.artifact,
                "handoff": item.handoff,
                "risks": item.risks,
                "issues": item.issues,
                "approved": item.approved,
                "childTaskId": item.child_task_id,
                "childSessionId": item.child_session_id,
                "status": item.status,
            })
        })
        .collect::<Vec<_>>();
    json!({
        "outputs": outputs,
        "promptSection": "subagent orchestration completed",
        "runtimeMode": "real-child-runtime",
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::{RuntimeArtifact, RuntimeTaskRecord};

    #[test]
    fn subagent_aggregation_preserves_legacy_outputs_shape() {
        let mut store = crate::AppStore::default();
        store.runtime_tasks.push(RuntimeTaskRecord {
            id: "child-task".to_string(),
            artifacts: vec![RuntimeArtifact::new(
                "subagent-output",
                "Subagent Output",
                None,
                None,
                Some(json!({"summary": "from task artifact"})),
            )],
            ..RuntimeTaskRecord::default()
        });

        let value = build_orchestration_value(
            &store,
            vec![SubAgentOutput {
                role_id: "planner".to_string(),
                summary: "from return".to_string(),
                child_task_id: Some("child-task".to_string()),
                child_session_id: Some("child-session".to_string()),
                status: "completed".to_string(),
                approved: true,
                ..SubAgentOutput::default()
            }],
        );

        let output = value
            .get("outputs")
            .and_then(Value::as_array)
            .and_then(|items| items.first())
            .cloned()
            .unwrap_or(Value::Null);
        assert_eq!(
            output.get("roleId").and_then(Value::as_str),
            Some("planner")
        );
        assert_eq!(
            output.get("childTaskId").and_then(Value::as_str),
            Some("child-task")
        );
        assert_eq!(
            output.get("status").and_then(Value::as_str),
            Some("completed")
        );
    }
}
