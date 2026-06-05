use serde::{de::DeserializeOwned, Serialize};
use serde_json::Value;

use crate::cli_runtime::CliExecutionStatus;

pub(super) fn execution_status_label(status: &CliExecutionStatus) -> String {
    match status {
        CliExecutionStatus::AwaitingEscalation => "waiting-approval".to_string(),
        other => serde_json::to_value(other)
            .ok()
            .and_then(|value| value.as_str().map(|text| text.replace('_', "-")))
            .unwrap_or_else(|| "unknown".to_string()),
    }
}

fn normalize_input_with_key(key: Option<&str>, value: Value) -> Value {
    match value {
        Value::Object(object) => Value::Object(
            object
                .into_iter()
                .map(|(child_key, child_value)| {
                    (
                        child_key.clone(),
                        normalize_input_with_key(Some(&child_key), child_value),
                    )
                })
                .collect(),
        ),
        Value::Array(items) => Value::Array(
            items
                .into_iter()
                .map(|item| normalize_input_with_key(None, item))
                .collect(),
        ),
        Value::String(text)
            if matches!(key, Some("scope" | "preferredScope")) && text.contains('-') =>
        {
            Value::String(text.replace('-', "_"))
        }
        other => other,
    }
}

pub(super) fn parse_payload<T: DeserializeOwned>(payload: &Value) -> Result<T, String> {
    serde_json::from_value(normalize_input_with_key(None, payload.clone()))
        .map_err(|error| error.to_string())
}

fn enum_output(key: &str, value: &str) -> Option<String> {
    match key {
        "scope" | "source" | "health" | "verificationStatus" => Some(value.replace('_', "-")),
        "status" => Some(match value {
            "awaiting_escalation" => "waiting-approval".to_string(),
            other => other.replace('_', "-"),
        }),
        _ => None,
    }
}

pub(super) fn normalize_output_with_key(key: Option<&str>, value: Value) -> Value {
    match value {
        Value::Object(object) => Value::Object(
            object
                .into_iter()
                .map(|(child_key, child_value)| {
                    (
                        child_key.clone(),
                        normalize_output_with_key(Some(&child_key), child_value),
                    )
                })
                .collect(),
        ),
        Value::Array(items) => Value::Array(
            items
                .into_iter()
                .map(|item| normalize_output_with_key(None, item))
                .collect(),
        ),
        Value::String(text) => key
            .and_then(|field| enum_output(field, &text))
            .map(Value::String)
            .unwrap_or(Value::String(text)),
        other => other,
    }
}

pub(super) fn to_ipc_value<T: Serialize>(value: T) -> Result<Value, String> {
    serde_json::to_value(value)
        .map(|raw| normalize_output_with_key(None, raw))
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn normalize_input_accepts_kebab_case_scope() {
        let normalized = normalize_input_with_key(
            None,
            json!({
                "scope": "workspace-local",
                "preferredScope": "task-ephemeral",
            }),
        );
        assert_eq!(
            normalized.get("scope").and_then(Value::as_str),
            Some("workspace_local")
        );
        assert_eq!(
            normalized.get("preferredScope").and_then(Value::as_str),
            Some("task_ephemeral")
        );
    }

    #[test]
    fn normalize_output_uses_renderer_enum_shapes() {
        let normalized = normalize_output_with_key(
            None,
            json!({
                "scope": "workspace_local",
                "source": "app_managed",
                "status": "awaiting_escalation",
            }),
        );
        assert_eq!(
            normalized.get("scope").and_then(Value::as_str),
            Some("workspace-local")
        );
        assert_eq!(
            normalized.get("source").and_then(Value::as_str),
            Some("app-managed")
        );
        assert_eq!(
            normalized.get("status").and_then(Value::as_str),
            Some("waiting-approval")
        );
    }
}
