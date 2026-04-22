use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::{json, Value};
use tauri::{AppHandle, State};

use crate::cli_runtime::{
    authorize_cli_execution, emit_cli_escalation_requested, emit_cli_execution_log,
    emit_cli_execution_started, emit_cli_execution_status, emit_cli_verification_finished,
    execution_log_metadata, execution_log_paths, load_host_shell_env, merge_execution_env,
    resolve_cli_environment, run_cli_verification, upsert_cli_execution_record,
    CliEnvironmentResolveRequest, CliEscalationRequestRecord, CliExecuteRequest,
    CliExecutionRecord, CliExecutionStatus, CliVerificationStatus,
};
use crate::process_utils::configure_background_command;
use crate::{make_id, now_i64, AppState};

fn normalize_cwd(request: &CliExecuteRequest, environment_root: &str) -> String {
    request
        .cwd
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(environment_root)
        .to_string()
}

fn split_log_chunks(content: &str, max_chars: usize) -> Vec<String> {
    if content.is_empty() {
        return Vec::new();
    }
    let mut chunks = Vec::new();
    let mut current = String::new();
    let mut count = 0usize;
    for ch in content.chars() {
        current.push(ch);
        count += 1;
        let boundary = ch == '\n' || count >= max_chars;
        if boundary {
            chunks.push(current.clone());
            current.clear();
            count = 0;
        }
    }
    if !current.is_empty() {
        chunks.push(current);
    }
    chunks
}

fn execution_record_metadata(
    stdout_path: &Path,
    stderr_path: &Path,
    escalation: Option<&CliEscalationRequestRecord>,
    approved_by_existing_grant: bool,
) -> Value {
    let mut metadata = execution_log_metadata(stdout_path, stderr_path);
    if let Some(object) = metadata.as_object_mut() {
        if let Some(escalation) = escalation {
            object.insert("escalationId".to_string(), json!(escalation.id));
            object.insert("escalationStatus".to_string(), json!(escalation.status));
            if approved_by_existing_grant {
                object.insert("approvedByEscalationId".to_string(), json!(escalation.id));
                object.insert(
                    "approvedScope".to_string(),
                    escalation
                        .metadata
                        .as_ref()
                        .and_then(|value| value.get("approvedScope"))
                        .cloned()
                        .unwrap_or(Value::Null),
                );
            }
        }
    }
    metadata
}

struct LocalCliCommandOutput {
    exit_code: Option<i32>,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

fn run_local_command_capture(
    argv: &[String],
    cwd: &Path,
    env: &BTreeMap<String, String>,
) -> Result<LocalCliCommandOutput, String> {
    let program = argv
        .first()
        .cloned()
        .ok_or_else(|| "cli execute requires argv[0]".to_string())?;
    let mut command = Command::new(program);
    command.args(&argv[1..]);
    command.current_dir(cwd);
    command.envs(env);
    configure_background_command(&mut command);
    let output = command.output().map_err(|error| error.to_string())?;
    Ok(LocalCliCommandOutput {
        exit_code: output.status.code(),
        stdout: output.stdout,
        stderr: output.stderr,
    })
}

pub fn execute_cli_command(
    app: &AppHandle,
    state: &State<'_, AppState>,
    request: CliExecuteRequest,
) -> Result<CliExecutionRecord, String> {
    if request.argv.is_empty() {
        return Err("cli execute requires at least one argv token".to_string());
    }

    let resolution = resolve_cli_environment(
        state,
        &CliEnvironmentResolveRequest {
            requested_environment_id: request.environment_id.clone(),
            preferred_scope: if request.task_id.is_some() {
                Some(crate::cli_runtime::CliEnvironmentScope::TaskEphemeral)
            } else if request
                .cwd
                .as_deref()
                .is_some_and(|value| !value.trim().is_empty())
            {
                Some(crate::cli_runtime::CliEnvironmentScope::WorkspaceLocal)
            } else {
                None
            },
            workspace_root: None,
            task_id: request.task_id.clone(),
            tool_id: request.tool_id.clone(),
            isolated: request.task_id.is_some(),
        },
    )?;
    let execution_id = make_id("cli-exec");
    let (stdout_path, stderr_path) = execution_log_paths(state, &execution_id)?;
    let host_env = load_host_shell_env()
        .unwrap_or_else(|_| std::env::vars().collect::<BTreeMap<String, String>>());
    let merged_env = merge_execution_env(&host_env, &resolution.environment, Some(&request.env));
    let cwd = normalize_cwd(&request, &resolution.environment.root_path);
    let session_id = request
        .session_id
        .clone()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "cli-runtime".to_string());
    let policy = authorize_cli_execution(
        state,
        &execution_id,
        &request,
        &resolution.environment,
        Path::new(&cwd),
    )?;

    let mut record = CliExecutionRecord {
        id: execution_id,
        session_id,
        task_id: request.task_id.clone(),
        runtime_id: request.runtime_id.clone(),
        environment_id: resolution.environment.id.clone(),
        tool_id: request.tool_id.clone(),
        command: request.argv.clone(),
        cwd: cwd.clone(),
        status: if policy.allowed {
            CliExecutionStatus::Running
        } else {
            CliExecutionStatus::AwaitingEscalation
        },
        exit_code: None,
        stdout_path: Some(stdout_path.to_string_lossy().to_string()),
        stderr_path: Some(stderr_path.to_string_lossy().to_string()),
        artifact_paths: Vec::new(),
        verification_status: CliVerificationStatus::Unknown,
        started_at: Some(now_i64()),
        finished_at: None,
        metadata: Some(execution_record_metadata(
            &stdout_path,
            &stderr_path,
            policy.escalation.as_ref(),
            policy.approved_by_existing_grant,
        )),
    };
    record = upsert_cli_execution_record(state, record)?;
    emit_cli_execution_started(app, &record);
    if !policy.allowed {
        emit_cli_execution_status(
            app,
            &record,
            Some("cli escalation required before command can continue"),
        );
        if let Some(escalation) = policy.escalation.as_ref() {
            emit_cli_escalation_requested(app, &record, escalation);
        }
        return Ok(record);
    }

    let local_output = run_local_command_capture(&request.argv, Path::new(&cwd), &merged_env)?;
    crate::cli_runtime::write_execution_logs(
        &stdout_path,
        &stderr_path,
        &local_output.stdout,
        &local_output.stderr,
    )?;
    let stdout_text = String::from_utf8_lossy(&local_output.stdout).to_string();
    let stderr_text = String::from_utf8_lossy(&local_output.stderr).to_string();
    for chunk in split_log_chunks(&stdout_text, 500) {
        emit_cli_execution_log(app, &record, "stdout", &chunk);
    }
    for chunk in split_log_chunks(&stderr_text, 500) {
        emit_cli_execution_log(app, &record, "stderr", &chunk);
    }

    record.exit_code = local_output.exit_code;
    record.finished_at = Some(now_i64());
    record.status = if local_output.exit_code == Some(0) {
        CliExecutionStatus::Completed
    } else {
        CliExecutionStatus::Failed
    };
    let mut reason = if record.status == CliExecutionStatus::Completed {
        Some("process exited successfully".to_string())
    } else {
        Some("process exited with non-zero status".to_string())
    };
    if !request.verification_rules.is_empty() {
        let outcome = run_cli_verification(state, record.clone(), &request.verification_rules)?;
        reason = Some(outcome.summary.clone());
        emit_cli_verification_finished(app, &outcome.execution, &outcome.summary);
        record = outcome.execution;
    } else {
        record = upsert_cli_execution_record(state, record)?;
    }
    emit_cli_execution_status(app, &record, reason.as_deref());
    Ok(record)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn split_log_chunks_keeps_full_content() {
        let chunks = split_log_chunks("abc\ndef", 3);
        assert_eq!(chunks.concat(), "abc\ndef");
        assert!(chunks.len() >= 2);
    }

    #[test]
    fn run_local_command_capture_collects_stdout() {
        let cwd = std::env::temp_dir();
        let env = std::env::vars().collect::<BTreeMap<String, String>>();
        let output =
            run_local_command_capture(&["rustc".to_string(), "--version".to_string()], &cwd, &env)
                .expect("rustc should run");
        let stdout = String::from_utf8_lossy(&output.stdout);
        assert_eq!(output.exit_code, Some(0));
        assert!(stdout.contains("rustc"));
    }

    #[test]
    fn run_local_command_capture_reports_non_zero_exit_code() {
        let cwd = std::env::temp_dir();
        let env = std::env::vars().collect::<BTreeMap<String, String>>();
        let output = run_local_command_capture(
            &["rustc".to_string(), "--definitely-invalid-flag".to_string()],
            &cwd,
            &env,
        )
        .expect("rustc should still execute");
        assert_ne!(output.exit_code, Some(0));
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(!stderr.trim().is_empty());
    }

    #[test]
    fn write_execution_logs_round_trip_with_capture_output() {
        let cwd = std::env::temp_dir();
        let env = std::env::vars().collect::<BTreeMap<String, String>>();
        let output =
            run_local_command_capture(&["rustc".to_string(), "--version".to_string()], &cwd, &env)
                .expect("rustc should run");
        let temp_root = std::env::temp_dir().join(format!("redbox-cli-exec-{}", crate::now_i64()));
        fs::create_dir_all(&temp_root).expect("temp dir should exist");
        let stdout_path = temp_root.join("stdout.log");
        let stderr_path = temp_root.join("stderr.log");
        crate::cli_runtime::write_execution_logs(
            &stdout_path,
            &stderr_path,
            &output.stdout,
            &output.stderr,
        )
        .expect("logs should write");
        let stdout = fs::read_to_string(&stdout_path).expect("stdout log should read");
        assert!(stdout.contains("rustc"));
        let _ = fs::remove_dir_all(&temp_root);
    }
}
