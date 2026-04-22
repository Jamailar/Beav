use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::now_i64;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeEventEnvelope<T>
where
    T: Serialize,
{
    pub event_type: String,
    pub session_id: Option<String>,
    pub task_id: Option<String>,
    pub runtime_id: Option<String>,
    pub parent_runtime_id: Option<String>,
    pub payload: T,
    pub timestamp: i64,
}

impl<T> RuntimeEventEnvelope<T>
where
    T: Serialize,
{
    pub fn new(
        event_type: impl Into<String>,
        session_id: Option<&str>,
        task_id: Option<&str>,
        runtime_id: Option<&str>,
        parent_runtime_id: Option<&str>,
        payload: T,
    ) -> Self {
        Self {
            event_type: event_type.into(),
            session_id: session_id.map(ToString::to_string),
            task_id: task_id.map(ToString::to_string),
            runtime_id: runtime_id.map(ToString::to_string),
            parent_runtime_id: parent_runtime_id.map(ToString::to_string),
            payload,
            timestamp: now_i64(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeToolOutputPayload {
    pub success: bool,
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub partial: Option<bool>,
}

impl RuntimeToolOutputPayload {
    pub fn final_result(success: bool, content: impl Into<String>) -> Self {
        Self {
            success,
            content: content.into(),
            partial: None,
        }
    }

    pub fn partial(content: impl Into<String>) -> Self {
        Self {
            success: true,
            content: content.into(),
            partial: Some(true),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeToolCallPayload {
    pub call_id: String,
    pub name: String,
    pub input: Value,
    pub description: String,
}

impl RuntimeToolCallPayload {
    pub fn new(
        call_id: impl Into<String>,
        name: impl Into<String>,
        input: Value,
        description: impl Into<String>,
    ) -> Self {
        Self {
            call_id: call_id.into(),
            name: name.into(),
            input,
            description: description.into(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeApprovalDetails {
    pub r#type: String,
    pub title: String,
    pub description: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub impact: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeApprovalRequestPayload {
    pub call_id: String,
    pub name: String,
    pub details: RuntimeApprovalDetails,
}

impl RuntimeApprovalRequestPayload {
    pub fn new(
        call_id: impl Into<String>,
        name: impl Into<String>,
        details: RuntimeApprovalDetails,
    ) -> Self {
        Self {
            call_id: call_id.into(),
            name: name.into(),
            details,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeApprovalResolutionPayload {
    pub call_id: String,
    pub confirmed: bool,
}

impl RuntimeApprovalResolutionPayload {
    pub fn new(call_id: impl Into<String>, confirmed: bool) -> Self {
        Self {
            call_id: call_id.into(),
            confirmed,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManuscriptScriptConfirmPayload {
    pub file_path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeToolResultPayload {
    pub call_id: String,
    pub name: String,
    pub output: RuntimeToolOutputPayload,
}

impl RuntimeToolResultPayload {
    pub fn new(
        call_id: impl Into<String>,
        name: impl Into<String>,
        output: RuntimeToolOutputPayload,
    ) -> Self {
        Self {
            call_id: call_id.into(),
            name: name.into(),
            output,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeCheckpointPayload {
    pub checkpoint_type: String,
    pub summary: String,
    pub payload: Option<Value>,
}

impl RuntimeCheckpointPayload {
    pub fn new(
        checkpoint_type: impl Into<String>,
        summary: impl Into<String>,
        payload: Option<Value>,
    ) -> Self {
        Self {
            checkpoint_type: checkpoint_type.into(),
            summary: summary.into(),
            payload,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeTaskNodeChangedPayload {
    pub node_id: String,
    pub status: String,
    pub summary: Option<String>,
    pub error: Option<String>,
}

impl RuntimeTaskNodeChangedPayload {
    pub fn new(
        node_id: impl Into<String>,
        status: impl Into<String>,
        summary: Option<&str>,
        error: Option<&str>,
    ) -> Self {
        Self {
            node_id: node_id.into(),
            status: status.into(),
            summary: summary.map(ToString::to_string),
            error: error.map(ToString::to_string),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeSubagentEventPayload {
    pub role_id: String,
    pub runtime_mode: String,
    pub child_runtime_id: Option<String>,
    pub child_task_id: Option<String>,
    pub child_session_id: Option<String>,
    pub parent_task_id: Option<String>,
    pub status: Option<String>,
    pub summary: Option<String>,
    pub error: Option<String>,
}

impl RuntimeSubagentEventPayload {
    pub fn new(
        role_id: impl Into<String>,
        runtime_mode: impl Into<String>,
        child_runtime_id: Option<&str>,
        child_task_id: Option<&str>,
        child_session_id: Option<&str>,
        parent_task_id: Option<&str>,
    ) -> Self {
        Self {
            role_id: role_id.into(),
            runtime_mode: runtime_mode.into(),
            child_runtime_id: child_runtime_id.map(ToString::to_string),
            child_task_id: child_task_id.map(ToString::to_string),
            child_session_id: child_session_id.map(ToString::to_string),
            parent_task_id: parent_task_id.map(ToString::to_string),
            status: None,
            summary: None,
            error: None,
        }
    }

    pub fn with_result(
        mut self,
        status: impl Into<String>,
        summary: Option<&str>,
        error: Option<&str>,
    ) -> Self {
        self.status = Some(status.into());
        self.summary = summary.map(ToString::to_string);
        self.error = error.map(ToString::to_string);
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn runtime_event_envelope_serializes_with_legacy_shape() {
        let value = serde_json::to_value(RuntimeEventEnvelope::new(
            "runtime:checkpoint",
            Some("session-1"),
            Some("task-1"),
            Some("runtime-1"),
            Some("parent-1"),
            RuntimeCheckpointPayload::new("chat.response_end", "done", Some(json!({ "ok": true }))),
        ))
        .unwrap();

        assert_eq!(
            value.get("eventType").and_then(Value::as_str),
            Some("runtime:checkpoint")
        );
        assert_eq!(
            value.get("sessionId").and_then(Value::as_str),
            Some("session-1")
        );
        assert!(value.get("payload").is_some());
    }

    #[test]
    fn runtime_tool_output_partial_omits_partial_flag_for_final_result() {
        let final_value =
            serde_json::to_value(RuntimeToolOutputPayload::final_result(true, "ok")).unwrap();
        assert!(final_value.get("partial").is_none());

        let partial_value =
            serde_json::to_value(RuntimeToolOutputPayload::partial("chunk")).unwrap();
        assert_eq!(
            partial_value.get("partial").and_then(Value::as_bool),
            Some(true)
        );
    }

    #[test]
    fn approval_payloads_round_trip_with_renderer_shape() {
        let request = RuntimeApprovalRequestPayload::new(
            "call-1",
            "bash",
            RuntimeApprovalDetails {
                r#type: "exec".to_string(),
                title: "Run command".to_string(),
                description: "Execute a shell command".to_string(),
                impact: Some("May modify files".to_string()),
            },
        );
        let request_value = serde_json::to_value(&request).unwrap();
        assert_eq!(
            request_value.get("callId").and_then(Value::as_str),
            Some("call-1")
        );
        assert_eq!(
            request_value
                .get("details")
                .and_then(Value::as_object)
                .and_then(|value| value.get("type"))
                .and_then(Value::as_str),
            Some("exec")
        );

        let parsed: RuntimeApprovalResolutionPayload =
            serde_json::from_value(json!({ "callId": "call-1", "confirmed": true })).unwrap();
        assert_eq!(parsed.call_id, "call-1");
        assert!(parsed.confirmed);
    }
}
