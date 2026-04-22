use serde_json::json;
use tauri::AppHandle;

use crate::cli_runtime::CliExecutionRecord;
use crate::events::emit_runtime_event_with_lineage;

fn execution_payload(record: &CliExecutionRecord) -> serde_json::Value {
    json!({
        "executionId": record.id,
        "environmentId": record.environment_id,
        "toolId": record.tool_id,
        "command": record.command,
        "cwd": record.cwd,
        "status": record.status,
        "exitCode": record.exit_code,
        "stdoutPath": record.stdout_path,
        "stderrPath": record.stderr_path,
        "verificationStatus": record.verification_status,
        "startedAt": record.started_at,
        "finishedAt": record.finished_at,
        "artifactPaths": record.artifact_paths,
    })
}

pub fn emit_cli_execution_started(app: &AppHandle, record: &CliExecutionRecord) {
    emit_runtime_event_with_lineage(
        app,
        "runtime:cli-execution-started",
        Some(&record.session_id),
        record.task_id.as_deref(),
        record.runtime_id.as_deref(),
        None,
        execution_payload(record),
    );
}

pub fn emit_cli_execution_log(
    app: &AppHandle,
    record: &CliExecutionRecord,
    stream: &str,
    content: &str,
) {
    if content.trim().is_empty() {
        return;
    }
    emit_runtime_event_with_lineage(
        app,
        "runtime:cli-execution-log",
        Some(&record.session_id),
        record.task_id.as_deref(),
        record.runtime_id.as_deref(),
        None,
        json!({
            "executionId": record.id,
            "environmentId": record.environment_id,
            "stream": stream,
            "content": content,
        }),
    );
}

pub fn emit_cli_execution_status(
    app: &AppHandle,
    record: &CliExecutionRecord,
    reason: Option<&str>,
) {
    let mut payload = execution_payload(record);
    if let Some(object) = payload.as_object_mut() {
        object.insert(
            "reason".to_string(),
            json!(reason.filter(|value| !value.trim().is_empty())),
        );
    }
    emit_runtime_event_with_lineage(
        app,
        "runtime:cli-execution-status",
        Some(&record.session_id),
        record.task_id.as_deref(),
        record.runtime_id.as_deref(),
        None,
        payload,
    );
}
