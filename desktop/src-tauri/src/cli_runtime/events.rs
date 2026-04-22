use serde_json::json;
use tauri::AppHandle;

use crate::cli_runtime::{CliEscalationRequestRecord, CliExecutionRecord, CliInstallMethod};
use crate::events::emit_runtime_event_with_lineage;

fn escalation_metadata_string(record: &CliEscalationRequestRecord, key: &str) -> Option<String> {
    record
        .metadata
        .as_ref()
        .and_then(|value| value.get(key))
        .and_then(|value| value.as_str())
        .map(ToString::to_string)
}

fn escalation_metadata_strings(record: &CliEscalationRequestRecord, key: &str) -> Vec<String> {
    record
        .metadata
        .as_ref()
        .and_then(|value| value.get(key))
        .and_then(|value| value.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str())
                .map(ToString::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn escalation_reason_label(record: &CliEscalationRequestRecord) -> String {
    match record.reason {
        crate::cli_runtime::CliEscalationReason::DangerousCommand => "命令需要额外确认",
        crate::cli_runtime::CliEscalationReason::PathOutsideWorkspace => "将写入工作区外路径",
        crate::cli_runtime::CliEscalationReason::SensitivePath => "将访问敏感路径",
        crate::cli_runtime::CliEscalationReason::NetworkAccess => "需要网络访问",
        crate::cli_runtime::CliEscalationReason::GlobalInstall => "将执行全局安装",
        crate::cli_runtime::CliEscalationReason::ElevatedPrivilege => "请求提升权限（sudo/doas）",
    }
    .to_string()
}

fn execution_payload(record: &CliExecutionRecord) -> serde_json::Value {
    json!({
        "executionId": record.id,
        "environmentId": record.environment_id,
        "toolId": record.tool_id,
        "toolName": record
            .tool_id
            .clone()
            .unwrap_or_else(|| record.command.first().cloned().unwrap_or_else(|| "cli".to_string())),
        "argv": record.command,
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
    let summary = reason.filter(|value| !value.trim().is_empty());
    let mut payload = execution_payload(record);
    if let Some(object) = payload.as_object_mut() {
        object.insert("reason".to_string(), json!(summary));
        object.insert("summary".to_string(), json!(summary));
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

pub fn emit_cli_install_started(
    app: &AppHandle,
    session_id: Option<&str>,
    task_id: Option<&str>,
    runtime_id: Option<&str>,
    install_id: &str,
    environment_id: Option<&str>,
    tool_name: &str,
    install_method: &CliInstallMethod,
    spec: &str,
) {
    emit_runtime_event_with_lineage(
        app,
        "runtime:cli-install-started",
        session_id,
        task_id,
        runtime_id,
        None,
        json!({
            "installId": install_id,
            "environmentId": environment_id,
            "toolName": tool_name,
            "installMethod": install_method,
            "spec": spec,
        }),
    );
}

pub fn emit_cli_install_finished(
    app: &AppHandle,
    session_id: Option<&str>,
    task_id: Option<&str>,
    runtime_id: Option<&str>,
    install_id: &str,
    execution_id: Option<&str>,
    environment_id: Option<&str>,
    tool_name: &str,
    status: &str,
    summary: &str,
) {
    emit_runtime_event_with_lineage(
        app,
        "runtime:cli-install-finished",
        session_id,
        task_id,
        runtime_id,
        None,
        json!({
            "installId": install_id,
            "executionId": execution_id,
            "environmentId": environment_id,
            "toolName": tool_name,
            "status": status,
            "summary": summary,
        }),
    );
}

pub fn emit_cli_escalation_requested(
    app: &AppHandle,
    execution: &CliExecutionRecord,
    escalation: &CliEscalationRequestRecord,
) {
    emit_runtime_event_with_lineage(
        app,
        "runtime:cli-escalation-requested",
        Some(&execution.session_id),
        execution.task_id.as_deref(),
        execution.runtime_id.as_deref(),
        None,
        json!({
            "escalationId": escalation.id,
            "executionId": escalation.execution_id,
            "status": escalation.status,
            "title": "CLI 需要额外权限",
            "description": escalation_metadata_string(escalation, "description"),
            "reason": escalation_reason_label(escalation),
            "commandPreview": escalation_metadata_string(escalation, "commandPreview"),
            "permissionSummary": escalation_metadata_strings(escalation, "permissionSummary"),
            "scopeOptions": escalation_metadata_strings(escalation, "scopeOptions"),
            "createdAt": escalation.created_at,
        }),
    );
}

pub fn emit_cli_escalation_resolved(
    app: &AppHandle,
    execution: Option<&CliExecutionRecord>,
    escalation: &CliEscalationRequestRecord,
) {
    let session_id = execution
        .map(|item| item.session_id.as_str())
        .unwrap_or(escalation.session_id.as_str());
    let task_id = execution
        .and_then(|item| item.task_id.as_deref())
        .or(escalation.task_id.as_deref());
    let runtime_id = execution.and_then(|item| item.runtime_id.as_deref());
    let summary =
        escalation_metadata_string(escalation, "resolutionNote").unwrap_or_else(
            || match escalation.status {
                crate::cli_runtime::CliEscalationStatus::Approved => {
                    "cli escalation approved; rerun execute to continue".to_string()
                }
                crate::cli_runtime::CliEscalationStatus::Denied => {
                    "cli escalation denied by user".to_string()
                }
                crate::cli_runtime::CliEscalationStatus::Pending => {
                    "cli escalation is still pending".to_string()
                }
            },
        );
    emit_runtime_event_with_lineage(
        app,
        "runtime:cli-escalation-resolved",
        Some(session_id),
        task_id,
        runtime_id,
        None,
        json!({
            "escalationId": escalation.id,
            "executionId": escalation.execution_id,
            "status": escalation.status,
            "scope": escalation_metadata_string(escalation, "approvedScope"),
            "summary": summary,
            "resolvedAt": escalation.resolved_at,
        }),
    );
}

pub fn emit_cli_verification_finished(app: &AppHandle, record: &CliExecutionRecord, summary: &str) {
    emit_runtime_event_with_lineage(
        app,
        "runtime:cli-verification-finished",
        Some(&record.session_id),
        record.task_id.as_deref(),
        record.runtime_id.as_deref(),
        None,
        json!({
            "executionId": record.id,
            "status": record.verification_status,
            "summary": summary,
        }),
    );
}
