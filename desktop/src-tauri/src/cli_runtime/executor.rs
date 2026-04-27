use std::collections::{BTreeMap, HashMap};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Manager, Runtime, State};

use crate::cli_runtime::{
    append_execution_log_chunk, authorize_cli_execution, build_cli_sandbox_spec,
    build_effective_environment, emit_cli_escalation_requested, emit_cli_execution_log,
    emit_cli_execution_started, emit_cli_execution_status, emit_cli_verification_finished,
    execution_log_metadata, execution_log_paths, find_cli_execution_by_id,
    initialize_execution_logs, load_cli_execution_snapshot, load_host_shell_snapshot,
    prepare_cli_launch, resolve_cli_environment, run_cli_verification, sandbox_metadata,
    spawn_cli_terminal, upsert_cli_execution_record, write_execution_logs,
    CliEnvironmentResolveRequest, CliEscalationRequestRecord, CliExecuteRequest, CliExecutionMode,
    CliExecutionRecord, CliExecutionSnapshot, CliExecutionStatus, CliVerificationStatus,
    CliVerifyRule,
};
use crate::process_utils::configure_background_command;
use crate::{make_id, now_i64, with_store, AppState};

fn normalize_cwd(request: &CliExecuteRequest, environment_root: &str) -> String {
    request
        .cwd
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(environment_root)
        .to_string()
}

pub fn default_cli_execution_mode(state: &State<'_, AppState>) -> Result<CliExecutionMode, String> {
    with_store(state, |store| {
        let mode = store
            .settings
            .get("cli_runtime_execution_mode")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or_default();
        Ok(match mode {
            "managed" => CliExecutionMode::Managed,
            "unrestricted" => CliExecutionMode::Unrestricted,
            _ => CliExecutionMode::HostCompatible,
        })
    })
}

fn apply_default_execution_mode(
    state: &State<'_, AppState>,
    mut request: CliExecuteRequest,
) -> Result<CliExecuteRequest, String> {
    if request.execution_mode.is_none() {
        request.execution_mode = Some(default_cli_execution_mode(state)?);
    }
    Ok(request)
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

struct BackgroundCliExecution {
    child: Mutex<Child>,
    cancellation_requested: AtomicBool,
    verification_rules: Vec<CliVerifyRule>,
    stdout_reader: Mutex<Option<JoinHandle<()>>>,
    stderr_reader: Mutex<Option<JoinHandle<()>>>,
}

static ACTIVE_BACKGROUND_EXECUTIONS: OnceLock<Mutex<HashMap<String, Arc<BackgroundCliExecution>>>> =
    OnceLock::new();

fn active_background_executions() -> &'static Mutex<HashMap<String, Arc<BackgroundCliExecution>>> {
    ACTIVE_BACKGROUND_EXECUTIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn active_background_execution_count() -> Result<usize, String> {
    active_background_executions()
        .lock()
        .map(|executions| executions.len())
        .map_err(|_| "active cli execution registry is poisoned".to_string())
}

fn run_local_command_capture(
    argv: &[String],
    cwd: &Path,
    env: &BTreeMap<String, String>,
    sandbox: &crate::cli_runtime::CliSandboxSpec,
) -> Result<LocalCliCommandOutput, String> {
    let launch = prepare_cli_launch(sandbox, argv, env)?;
    let mut command = Command::new(launch.program);
    command.args(&launch.args);
    command.current_dir(cwd);
    command.envs(&launch.env);
    configure_background_command(&mut command);
    let output = command.output().map_err(|error| error.to_string())?;
    Ok(LocalCliCommandOutput {
        exit_code: output.status.code(),
        stdout: output.stdout,
        stderr: output.stderr,
    })
}

fn register_background_execution(
    execution_id: String,
    runtime: Arc<BackgroundCliExecution>,
) -> Result<(), String> {
    let mut guard = active_background_executions()
        .lock()
        .map_err(|_| "cli background execution registry lock is poisoned".to_string())?;
    guard.insert(execution_id, runtime);
    Ok(())
}

fn get_background_execution(
    execution_id: &str,
) -> Result<Option<Arc<BackgroundCliExecution>>, String> {
    let guard = active_background_executions()
        .lock()
        .map_err(|_| "cli background execution registry lock is poisoned".to_string())?;
    Ok(guard.get(execution_id).cloned())
}

fn take_background_execution(
    execution_id: &str,
) -> Result<Option<Arc<BackgroundCliExecution>>, String> {
    let mut guard = active_background_executions()
        .lock()
        .map_err(|_| "cli background execution registry lock is poisoned".to_string())?;
    Ok(guard.remove(execution_id))
}

fn take_reader_handle(reader: &Mutex<Option<JoinHandle<()>>>) -> Option<JoinHandle<()>> {
    reader.lock().ok().and_then(|mut guard| guard.take())
}

fn join_background_readers(runtime: &BackgroundCliExecution) {
    if let Some(handle) = take_reader_handle(&runtime.stdout_reader) {
        let _ = handle.join();
    }
    if let Some(handle) = take_reader_handle(&runtime.stderr_reader) {
        let _ = handle.join();
    }
}

fn spawn_execution_log_reader<RT: Runtime, R: Read + Send + 'static>(
    app: AppHandle<RT>,
    record: CliExecutionRecord,
    stream: &'static str,
    path: PathBuf,
    mut reader: R,
) -> JoinHandle<()> {
    thread::spawn(move || {
        let mut buffer = [0u8; 4_096];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(count) => {
                    let chunk = &buffer[..count];
                    if let Err(error) = append_execution_log_chunk(&path, chunk) {
                        eprintln!(
                            "[cli runtime] failed to append {stream} log for {}: {error}",
                            record.id
                        );
                    }
                    let text = String::from_utf8_lossy(chunk).to_string();
                    emit_cli_execution_log(&app, &record, stream, &text);
                }
                Err(error) => {
                    eprintln!(
                        "[cli runtime] failed to read {stream} output for {}: {error}",
                        record.id
                    );
                    break;
                }
            }
        }
    })
}

fn finalize_background_execution<RT: Runtime>(
    app: &AppHandle<RT>,
    execution_id: &str,
    runtime: Arc<BackgroundCliExecution>,
    exit_status: ExitStatus,
) -> Result<Option<CliExecutionRecord>, String> {
    join_background_readers(&runtime);
    let state = app.state::<AppState>();
    let Some(mut record) = find_cli_execution_by_id(&state, execution_id)? else {
        return Ok(None);
    };
    let cancelled = runtime.cancellation_requested.load(Ordering::SeqCst)
        || record.status == CliExecutionStatus::Cancelled;
    record.exit_code = exit_status.code();
    if record.finished_at.is_none() {
        record.finished_at = Some(now_i64());
    }
    record.status = if cancelled {
        CliExecutionStatus::Cancelled
    } else if exit_status.success() {
        CliExecutionStatus::Completed
    } else {
        CliExecutionStatus::Failed
    };
    if cancelled && !runtime.verification_rules.is_empty() {
        record.verification_status = CliVerificationStatus::Skipped;
    }

    let mut reason = match record.status {
        CliExecutionStatus::Cancelled => Some("process cancelled".to_string()),
        CliExecutionStatus::Completed => Some("process exited successfully".to_string()),
        CliExecutionStatus::Failed => Some("process exited with non-zero status".to_string()),
        _ => None,
    };

    if !runtime.verification_rules.is_empty() && !cancelled {
        let stored_execution = upsert_cli_execution_record(&state, record)?;
        let outcome = run_cli_verification(&state, stored_execution, &runtime.verification_rules)?;
        reason = Some(outcome.summary.clone());
        emit_cli_verification_finished(app, &outcome.execution, &outcome.summary);
        record = outcome.execution;
    } else {
        record = upsert_cli_execution_record(&state, record)?;
    }

    emit_cli_execution_status(app, &record, reason.as_deref());
    Ok(Some(record))
}

fn spawn_background_reaper<RT: Runtime>(app: AppHandle<RT>, execution_id: String) {
    tauri::async_runtime::spawn(async move {
        loop {
            match refresh_cli_execution(&app, &execution_id) {
                Ok(Some(_)) => break,
                Ok(None) => match get_background_execution(&execution_id) {
                    Ok(Some(_)) => tokio::time::sleep(Duration::from_millis(100)).await,
                    Ok(None) => break,
                    Err(error) => {
                        eprintln!(
                        "[cli runtime] failed to inspect background execution {execution_id}: {error}"
                    );
                        break;
                    }
                },
                Err(error) => {
                    eprintln!(
                    "[cli runtime] failed to refresh background execution {execution_id}: {error}"
                );
                    break;
                }
            }
        }
    });
}

fn fail_execution_launch<RT: Runtime>(
    app: &AppHandle<RT>,
    state: &State<'_, AppState>,
    mut record: CliExecutionRecord,
    error: String,
) -> Result<CliExecutionRecord, String> {
    record.status = CliExecutionStatus::Failed;
    record.finished_at = Some(now_i64());
    record = upsert_cli_execution_record(state, record)?;
    emit_cli_execution_status(app, &record, Some(&error));
    Err(error)
}

fn launch_background_execution<RT: Runtime>(
    app: &AppHandle<RT>,
    request: &CliExecuteRequest,
    record: &CliExecutionRecord,
    cwd: &str,
    env: &BTreeMap<String, String>,
    sandbox: &crate::cli_runtime::CliSandboxSpec,
    stdout_path: &Path,
    stderr_path: &Path,
) -> Result<(), String> {
    initialize_execution_logs(stdout_path, stderr_path)?;
    let terminal = spawn_cli_terminal(&request.argv, Path::new(cwd), env, sandbox)?;
    let mut child = terminal.child;
    let stdout_reader = child
        .stdout
        .take()
        .ok_or_else(|| "cli background execution missing stdout pipe".to_string())?;
    let stderr_reader = child
        .stderr
        .take()
        .ok_or_else(|| "cli background execution missing stderr pipe".to_string())?;
    let runtime = Arc::new(BackgroundCliExecution {
        child: Mutex::new(child),
        cancellation_requested: AtomicBool::new(false),
        verification_rules: request.verification_rules.clone(),
        stdout_reader: Mutex::new(Some(spawn_execution_log_reader(
            app.clone(),
            record.clone(),
            "stdout",
            stdout_path.to_path_buf(),
            stdout_reader,
        ))),
        stderr_reader: Mutex::new(Some(spawn_execution_log_reader(
            app.clone(),
            record.clone(),
            "stderr",
            stderr_path.to_path_buf(),
            stderr_reader,
        ))),
    });
    if let Err(error) = register_background_execution(record.id.clone(), Arc::clone(&runtime)) {
        if let Ok(mut child) = runtime.child.lock() {
            let _ = child.kill();
            let _ = child.wait();
        }
        join_background_readers(&runtime);
        return Err(error);
    }
    emit_cli_execution_status(app, record, Some("process running in background"));
    spawn_background_reaper(app.clone(), record.id.clone());
    Ok(())
}

pub fn refresh_cli_execution<RT: Runtime>(
    app: &AppHandle<RT>,
    execution_id: &str,
) -> Result<Option<CliExecutionRecord>, String> {
    let Some(runtime) = get_background_execution(execution_id)? else {
        return Ok(None);
    };
    let exit_status = {
        let mut child = runtime
            .child
            .lock()
            .map_err(|_| "cli execution process lock is poisoned".to_string())?;
        child.try_wait().map_err(|error| error.to_string())?
    };
    let Some(exit_status) = exit_status else {
        return Ok(None);
    };
    let Some(runtime) = take_background_execution(execution_id)? else {
        return Ok(None);
    };
    finalize_background_execution(app, execution_id, runtime, exit_status)
}

pub fn cancel_cli_execution<RT: Runtime>(
    app: &AppHandle<RT>,
    state: &State<'_, AppState>,
    execution_id: &str,
) -> Result<CliExecutionRecord, String> {
    let Some(mut record) = find_cli_execution_by_id(state, execution_id)? else {
        return Err(format!("cli execution not found: {execution_id}"));
    };

    match record.status {
        CliExecutionStatus::Completed
        | CliExecutionStatus::Failed
        | CliExecutionStatus::Cancelled => Ok(record),
        CliExecutionStatus::Pending | CliExecutionStatus::AwaitingEscalation => {
            record.status = CliExecutionStatus::Cancelled;
            record.finished_at = Some(now_i64());
            record = upsert_cli_execution_record(state, record)?;
            emit_cli_execution_status(app, &record, Some("process cancelled before start"));
            Ok(record)
        }
        CliExecutionStatus::Running => {
            let Some(runtime) = get_background_execution(execution_id)? else {
                return Err(
                    "cli execution is not registered as a cancellable background task".to_string(),
                );
            };
            runtime.cancellation_requested.store(true, Ordering::SeqCst);
            {
                let mut child = runtime
                    .child
                    .lock()
                    .map_err(|_| "cli execution process lock is poisoned".to_string())?;
                if let Err(error) = child.kill() {
                    let still_running = child
                        .try_wait()
                        .map_err(|wait_error| wait_error.to_string())?
                        .is_none();
                    if still_running {
                        return Err(error.to_string());
                    }
                }
            }
            record.status = CliExecutionStatus::Cancelled;
            record.finished_at = Some(now_i64());
            if !runtime.verification_rules.is_empty() {
                record.verification_status = CliVerificationStatus::Skipped;
            }
            record = upsert_cli_execution_record(state, record)?;
            emit_cli_execution_status(app, &record, Some("process cancellation requested"));
            let _ = refresh_cli_execution(app, execution_id);
            find_cli_execution_by_id(state, execution_id)?
                .ok_or_else(|| format!("cli execution not found: {execution_id}"))
        }
    }
}

pub fn execute_cli_command<RT: Runtime>(
    app: &AppHandle<RT>,
    state: &State<'_, AppState>,
    request: CliExecuteRequest,
) -> Result<CliExecutionRecord, String> {
    let request = apply_default_execution_mode(state, request)?;
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
    let host = load_host_shell_snapshot();
    let effective =
        build_effective_environment(&host, Some(&resolution.environment), Some(&request.env));
    let merged_env = effective.env.clone();
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
    let sandbox = build_cli_sandbox_spec(
        &request,
        &resolution.environment,
        Path::new(&cwd),
        &merged_env,
        &policy.permissions,
    );

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
    record.metadata = match record.metadata.take() {
        Some(Value::Object(mut object)) => {
            object.insert("sandbox".to_string(), sandbox_metadata(&sandbox));
            object.insert(
                "effectiveEnvironment".to_string(),
                effective.metadata_value(),
            );
            object.insert("hostShell".to_string(), host.metadata_value());
            Some(Value::Object(object))
        }
        Some(other) => Some(json!({
            "log": other,
            "sandbox": sandbox_metadata(&sandbox),
            "effectiveEnvironment": effective.metadata_value(),
            "hostShell": host.metadata_value(),
        })),
        None => Some(json!({
            "sandbox": sandbox_metadata(&sandbox),
            "effectiveEnvironment": effective.metadata_value(),
            "hostShell": host.metadata_value(),
        })),
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

    if request.use_pty {
        return match launch_background_execution(
            app,
            &request,
            &record,
            &cwd,
            &merged_env,
            &sandbox,
            &stdout_path,
            &stderr_path,
        ) {
            Ok(()) => Ok(record),
            Err(error) => fail_execution_launch(app, state, record, error),
        };
    }

    let local_output =
        match run_local_command_capture(&request.argv, Path::new(&cwd), &merged_env, &sandbox) {
            Ok(output) => output,
            Err(error) => return fail_execution_launch(app, state, record, error),
        };
    write_execution_logs(
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

fn execution_failure_summary(snapshot: &CliExecutionSnapshot) -> String {
    if snapshot.execution.status == CliExecutionStatus::AwaitingEscalation {
        return "cli execution requires escalation before it can continue".to_string();
    }
    if snapshot.execution.verification_status == CliVerificationStatus::Failed {
        if let Some(summary) = snapshot
            .verifications
            .iter()
            .find(|record| record.status == CliVerificationStatus::Failed)
            .map(|record| record.summary.trim().to_string())
            .filter(|summary| !summary.is_empty())
        {
            return summary;
        }
    }
    let stderr = snapshot.stderr_tail.trim();
    if !stderr.is_empty() {
        return stderr.to_string();
    }
    let stdout = snapshot.stdout_tail.trim();
    if !stdout.is_empty() {
        return stdout.to_string();
    }
    match &snapshot.execution.status {
        CliExecutionStatus::Failed => snapshot
            .execution
            .exit_code
            .map(|code| format!("cli execution failed with exit code {code}"))
            .unwrap_or_else(|| "cli execution failed".to_string()),
        CliExecutionStatus::Cancelled => "cli execution was cancelled".to_string(),
        other => format!("cli execution did not complete successfully: {other:?}"),
    }
}

pub fn run_managed_cli_command<RT: Runtime>(
    app: &AppHandle<RT>,
    state: &State<'_, AppState>,
    request: CliExecuteRequest,
    max_chars: usize,
) -> Result<CliExecutionSnapshot, String> {
    let execution = execute_cli_command(app, state, request)?;
    if execution.status == CliExecutionStatus::AwaitingEscalation {
        let snapshot = load_cli_execution_snapshot(state, &execution.id, max_chars)?
            .ok_or_else(|| format!("cli execution not found after launch: {}", execution.id))?;
        return Err(execution_failure_summary(&snapshot));
    }

    let final_execution = if execution.status == CliExecutionStatus::Running {
        loop {
            if let Some(refreshed) = refresh_cli_execution(app, &execution.id)? {
                break refreshed;
            }
            thread::sleep(Duration::from_millis(100));
        }
    } else {
        execution
    };

    let snapshot =
        load_cli_execution_snapshot(state, &final_execution.id, max_chars)?.ok_or_else(|| {
            format!(
                "cli execution not found after completion: {}",
                final_execution.id
            )
        })?;
    let failed = matches!(
        snapshot.execution.status,
        CliExecutionStatus::Failed | CliExecutionStatus::Cancelled
    ) || snapshot.execution.verification_status == CliVerificationStatus::Failed;
    if failed {
        return Err(execution_failure_summary(&snapshot));
    }
    Ok(snapshot)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;
    use std::fs;
    use std::sync::Arc;
    use tauri::test::{mock_builder, mock_context, noop_assets};

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
        let sandbox = crate::cli_runtime::CliSandboxSpec::default();
        let output = run_local_command_capture(
            &["rustc".to_string(), "--version".to_string()],
            &cwd,
            &env,
            &sandbox,
        )
        .expect("rustc should run");
        let stdout = String::from_utf8_lossy(&output.stdout);
        assert_eq!(output.exit_code, Some(0));
        assert!(stdout.contains("rustc"));
    }

    #[test]
    fn run_local_command_capture_reports_non_zero_exit_code() {
        let cwd = std::env::temp_dir();
        let env = std::env::vars().collect::<BTreeMap<String, String>>();
        let sandbox = crate::cli_runtime::CliSandboxSpec::default();
        let output = run_local_command_capture(
            &["rustc".to_string(), "--definitely-invalid-flag".to_string()],
            &cwd,
            &env,
            &sandbox,
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
        let sandbox = crate::cli_runtime::CliSandboxSpec::default();
        let output = run_local_command_capture(
            &["rustc".to_string(), "--version".to_string()],
            &cwd,
            &env,
            &sandbox,
        )
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

    static EXECUTOR_TEST_COUNTER: AtomicU64 = AtomicU64::new(0);
    static EXECUTOR_TEST_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

    fn executor_test_lock() -> &'static Mutex<()> {
        EXECUTOR_TEST_LOCK.get_or_init(|| Mutex::new(()))
    }

    fn test_store_root() -> PathBuf {
        let nonce = EXECUTOR_TEST_COUNTER.fetch_add(1, Ordering::SeqCst);
        std::env::temp_dir().join(format!(
            "redbox-cli-runtime-test-{}-{nonce}",
            crate::now_i64()
        ))
    }

    fn build_test_app() -> tauri::App<tauri::test::MockRuntime> {
        let temp_root = test_store_root();
        let workspace_root = temp_root.join("workspace");
        fs::create_dir_all(&workspace_root).expect("workspace root should exist");
        let store_path = temp_root.join("store.json");
        let store = crate::persistence::load_store(&store_path);
        let shared_store = Arc::new(Mutex::new(store));
        mock_builder()
            .manage(crate::AppState {
                store_path,
                store: shared_store,
                workspace_root_cache: Mutex::new(workspace_root),
                startup_migration: Mutex::new(
                    crate::startup_migration::StartupMigrationStatus::default(),
                ),
                store_persist_version: Arc::new(AtomicU64::new(0)),
                store_persist_scheduled: Arc::new(AtomicBool::new(false)),
                auth_runtime: Mutex::new(crate::AuthRuntimeState::default()),
                official_auth_refresh_lock: Mutex::new(()),
                official_wechat_status_lock: Mutex::new(()),
                official_cache_refresh_inflight: AtomicBool::new(false),
                mcp_manager: crate::mcp::McpManager::default(),
                chat_runtime_states: Mutex::new(HashMap::new()),
                editor_runtime_states: Mutex::new(HashMap::new()),
                active_chat_requests: Mutex::new(HashMap::new()),
                creative_chat_cancellations: Mutex::new(HashSet::new()),
                assistant_runtime: Mutex::new(None),
                assistant_sidecar: Mutex::new(None),
                redclaw_runtime: Mutex::new(None),
                media_generation_runtime: Mutex::new(None),
                runtime_warm: Mutex::new(crate::RuntimeWarmState::default()),
                approval_runtime: Mutex::new(crate::ApprovalRuntimeState::default()),
                skill_watch: Mutex::new(crate::skills::SkillWatcherSnapshot::default()),
                diagnostics: Mutex::new(crate::DiagnosticsState::default()),
                knowledge_index_state: Mutex::new(
                    crate::knowledge_index::KnowledgeIndexRuntimeState::default(),
                ),
            })
            .build(mock_context(noop_assets()))
            .expect("mock app should build")
    }

    #[cfg(not(target_os = "windows"))]
    fn completed_background_command() -> Vec<String> {
        vec![
            "sh".to_string(),
            "-c".to_string(),
            "sleep 1; printf 'done\\n'".to_string(),
        ]
    }

    #[cfg(target_os = "windows")]
    fn completed_background_command() -> Vec<String> {
        vec![
            "powershell".to_string(),
            "-NoProfile".to_string(),
            "-Command".to_string(),
            "Start-Sleep -Seconds 1; Write-Output 'done'".to_string(),
        ]
    }

    #[cfg(not(target_os = "windows"))]
    fn cancellable_background_command() -> Vec<String> {
        vec![
            "sh".to_string(),
            "-c".to_string(),
            "printf 'started\\n'; sleep 10".to_string(),
        ]
    }

    #[cfg(target_os = "windows")]
    fn cancellable_background_command() -> Vec<String> {
        vec![
            "powershell".to_string(),
            "-NoProfile".to_string(),
            "-Command".to_string(),
            "Write-Output 'started'; Start-Sleep -Seconds 10".to_string(),
        ]
    }

    fn wait_for_status<RT: Runtime>(
        app: &AppHandle<RT>,
        execution_id: &str,
        expected: CliExecutionStatus,
    ) -> CliExecutionRecord {
        for _ in 0..60 {
            if let Err(error) = refresh_cli_execution(app, execution_id) {
                panic!("failed to refresh execution {execution_id}: {error}");
            }
            let state = app.state::<crate::AppState>();
            let record = find_cli_execution_by_id(&state, execution_id)
                .expect("execution lookup should succeed")
                .expect("execution should exist");
            if record.status == expected {
                return record;
            }
            if matches!(
                record.status,
                CliExecutionStatus::Completed
                    | CliExecutionStatus::Failed
                    | CliExecutionStatus::Cancelled
            ) && record.status != expected
            {
                panic!(
                    "execution {execution_id} reached unexpected terminal status {:?}",
                    record.status
                );
            }
            thread::sleep(Duration::from_millis(100));
        }
        let state = app.state::<crate::AppState>();
        let record = find_cli_execution_by_id(&state, execution_id)
            .expect("execution lookup should succeed")
            .expect("execution should exist");
        panic!(
            "execution {execution_id} did not reach expected status; last status {:?}",
            record.status
        );
    }

    #[test]
    fn background_execution_poll_transitions_from_running_to_completed() {
        let _guard = executor_test_lock()
            .lock()
            .expect("executor test lock should not be poisoned");
        let app = build_test_app();
        let app_handle = app.handle().clone();
        let state = app.state::<crate::AppState>();
        let environment = crate::cli_runtime::ensure_app_global_environment(&state)
            .expect("app environment should exist");
        let cwd = std::env::temp_dir().join(format!("redbox-cli-runtime-cwd-{}", crate::now_i64()));
        fs::create_dir_all(&cwd).expect("cwd should exist");

        let execution = execute_cli_command(
            &app_handle,
            &state,
            CliExecuteRequest {
                environment_id: Some(environment.id),
                argv: completed_background_command(),
                cwd: Some(cwd.to_string_lossy().to_string()),
                use_pty: true,
                ..CliExecuteRequest::default()
            },
        )
        .expect("background execution should start");
        assert_eq!(execution.status, CliExecutionStatus::Running);

        let snapshot = crate::cli_runtime::load_cli_execution_snapshot(&state, &execution.id, 200)
            .expect("snapshot should load")
            .expect("snapshot should exist");
        assert_eq!(snapshot.execution.status, CliExecutionStatus::Running);

        let record = wait_for_status(&app_handle, &execution.id, CliExecutionStatus::Completed);
        assert_eq!(record.exit_code, Some(0));

        let state = app.state::<crate::AppState>();
        let snapshot = crate::cli_runtime::load_cli_execution_snapshot(&state, &execution.id, 200)
            .expect("snapshot should load")
            .expect("snapshot should exist");
        assert_eq!(snapshot.execution.status, CliExecutionStatus::Completed);
        assert!(snapshot.stdout_tail.contains("done"));
    }

    #[test]
    fn cancel_cli_execution_stops_background_process_and_marks_cancelled() {
        let _guard = executor_test_lock()
            .lock()
            .expect("executor test lock should not be poisoned");
        let app = build_test_app();
        let app_handle = app.handle().clone();
        let state = app.state::<crate::AppState>();
        let environment = crate::cli_runtime::ensure_app_global_environment(&state)
            .expect("app environment should exist");
        let cwd =
            std::env::temp_dir().join(format!("redbox-cli-runtime-cancel-{}", crate::now_i64()));
        fs::create_dir_all(&cwd).expect("cwd should exist");

        let execution = execute_cli_command(
            &app_handle,
            &state,
            CliExecuteRequest {
                environment_id: Some(environment.id),
                argv: cancellable_background_command(),
                cwd: Some(cwd.to_string_lossy().to_string()),
                use_pty: true,
                ..CliExecuteRequest::default()
            },
        )
        .expect("background execution should start");
        assert_eq!(execution.status, CliExecutionStatus::Running);

        let cancelled =
            cancel_cli_execution(&app_handle, &state, &execution.id).expect("cancel should work");
        assert_eq!(cancelled.status, CliExecutionStatus::Cancelled);

        let record = wait_for_status(&app_handle, &execution.id, CliExecutionStatus::Cancelled);
        assert_eq!(record.status, CliExecutionStatus::Cancelled);

        let state = app.state::<crate::AppState>();
        let snapshot = crate::cli_runtime::load_cli_execution_snapshot(&state, &execution.id, 200)
            .expect("snapshot should load")
            .expect("snapshot should exist");
        assert_eq!(snapshot.execution.status, CliExecutionStatus::Cancelled);
        assert!(snapshot.execution.finished_at.is_some());
    }

    #[test]
    fn run_managed_cli_command_returns_snapshot_for_completed_command() {
        let _guard = executor_test_lock()
            .lock()
            .expect("executor test lock should not be poisoned");
        let app = build_test_app();
        let app_handle = app.handle().clone();
        let state = app.state::<crate::AppState>();
        let cwd = std::env::temp_dir();

        let snapshot = run_managed_cli_command(
            &app_handle,
            &state,
            CliExecuteRequest {
                argv: vec!["echo".to_string(), "cli-runtime-ok".to_string()],
                cwd: Some(cwd.to_string_lossy().to_string()),
                ..CliExecuteRequest::default()
            },
            400,
        )
        .expect("managed command should succeed");

        assert_eq!(snapshot.execution.status, CliExecutionStatus::Completed);
        assert!(snapshot.stdout_tail.contains("cli-runtime-ok"));
    }
}
