use std::collections::HashMap;
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, State};

use crate::events::emit_runtime_event;
use crate::mcp::build_team_mcp_bridge_config;
use crate::persistence::with_store_mut;
use crate::process_utils::configure_background_command;
use crate::runtime::{
    add_collab_member, create_collab_task, submit_collab_report, update_collab_task,
    CollabMemberRecord, CollabProgressReportRecord, CollabTaskRecord,
};
use crate::{make_id, now_i64, payload_string, AppState, AppStore};

const DEFAULT_ACP_TIMEOUT_MS: u64 = 10 * 60 * 1000;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpMemberRunLaunch {
    pub run_id: String,
    pub session_id: String,
    pub member_id: String,
    pub task_id: String,
    pub backend: String,
    pub command: String,
    pub args: Vec<String>,
    pub status: String,
    pub mcp_bridge_config: Value,
}

#[derive(Debug, Clone)]
struct AcpExecutionPlan {
    run_id: String,
    session_id: String,
    member_id: String,
    task_id: String,
    backend: String,
    command: String,
    args: Vec<String>,
    cwd: Option<String>,
    env: HashMap<String, String>,
    prompt: String,
    stdin_prompt: bool,
    timeout_ms: u64,
}

#[derive(Debug, Clone)]
struct AcpProcessOutput {
    exit_code: Option<i32>,
    stdout: String,
    stderr: String,
    timed_out: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AcpRunPreparation {
    launch: AcpMemberRunLaunch,
    member: CollabMemberRecord,
    task: CollabTaskRecord,
}

fn payload_array_strings(payload: &Value, key: &str) -> Vec<String> {
    match payload.get(key) {
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToString::to_string)
            .collect(),
        Some(Value::String(value)) => shell_words::split(value).unwrap_or_default(),
        _ => Vec::new(),
    }
}

fn payload_bool(payload: &Value, key: &str, default_value: bool) -> bool {
    payload
        .get(key)
        .and_then(Value::as_bool)
        .unwrap_or(default_value)
}

fn payload_timeout_ms(payload: &Value) -> u64 {
    payload
        .get("timeoutMs")
        .and_then(Value::as_u64)
        .filter(|value| *value >= 1_000)
        .unwrap_or(DEFAULT_ACP_TIMEOUT_MS)
}

fn payload_env(payload: &Value) -> HashMap<String, String> {
    payload
        .get("env")
        .and_then(Value::as_object)
        .map(|object| {
            object
                .iter()
                .filter_map(|(key, value)| {
                    value
                        .as_str()
                        .map(|value| (key.to_string(), value.to_string()))
                })
                .collect()
        })
        .unwrap_or_default()
}

fn command_for_backend(backend: &str, payload: &Value) -> String {
    payload_string(payload, "command").unwrap_or_else(|| match backend {
        "aionrs" => "aionrs".to_string(),
        "codex" => "codex".to_string(),
        "gemini" => "gemini".to_string(),
        "claude" => "claude".to_string(),
        "fake" | "test" => "redbox-acp-fake".to_string(),
        other => other.to_string(),
    })
}

fn task_prompt(task: &CollabTaskRecord, payload: &Value) -> String {
    payload_string(payload, "prompt").unwrap_or_else(|| {
        format!(
            "{}\n\nObjective:\n{}\n\nDescription:\n{}",
            task.title, task.objective, task.description
        )
    })
}

fn compact_text(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value.to_string();
    }
    let mut output = value.chars().take(max_chars).collect::<String>();
    output.push_str("\n...[truncated]");
    output
}

fn merge_metadata(existing: Option<&Value>, patch: Value) -> Value {
    let mut object = existing
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    if let Some(patch) = patch.as_object() {
        for (key, value) in patch {
            object.insert(key.clone(), value.clone());
        }
    }
    Value::Object(object)
}

fn prepare_external_acp_run_in_store(
    store: &mut AppStore,
    payload: &Value,
) -> Result<(AcpRunPreparation, AcpExecutionPlan), String> {
    let session_id =
        payload_string(payload, "sessionId").ok_or_else(|| "缺少 sessionId".to_string())?;
    let backend = payload_string(payload, "backend").unwrap_or_else(|| "acp".to_string());
    let command = command_for_backend(&backend, payload);
    let args = payload_array_strings(payload, "args");
    let run_id = make_id("acp-run");

    let member = if let Some(member_id) = payload_string(payload, "memberId") {
        let member = store
            .collab_members
            .iter_mut()
            .find(|member| member.id == member_id && member.session_id == session_id)
            .ok_or_else(|| "外部 ACP 成员不存在或不属于该会话".to_string())?;
        member.source_kind = "external_acp".to_string();
        member.adapter_kind = "acp".to_string();
        member.backend = backend.clone();
        member.status = "working".to_string();
        member.last_seen_at = Some(now_i64());
        member.last_activity_at = Some(now_i64());
        member.updated_at = now_i64();
        member.metadata = Some(merge_metadata(
            member.metadata.as_ref(),
            json!({
                "activeAcpRunId": run_id,
                "command": command,
                "args": args,
            }),
        ));
        member.clone()
    } else {
        add_collab_member(
            store,
            &json!({
                "sessionId": session_id,
                "displayName": payload_string(payload, "displayName").unwrap_or_else(|| format!("{backend} agent")),
                "roleId": payload_string(payload, "roleId").unwrap_or_else(|| "external-agent".to_string()),
                "sourceKind": "external_acp",
                "adapterKind": "acp",
                "backend": backend,
                "status": "working",
                "capabilities": ["acp_process", "team_mcp_contract"],
                "allowedTools": ["redbox-team"],
                "desiredModelConfig": payload.get("desiredModelConfig").cloned().unwrap_or_else(|| json!({})),
                "metadata": {
                    "activeAcpRunId": run_id,
                    "command": command,
                    "args": args,
                }
            }),
        )?
    };

    let task = if let Some(task_id) = payload_string(payload, "taskId") {
        update_collab_task(
            store,
            &json!({
                "taskId": task_id,
                "memberId": member.id,
                "status": "running",
                "externalTaskRef": run_id,
                "metadata": {
                    "activeAcpRunId": run_id,
                    "backend": backend,
                    "command": command,
                    "args": args,
                }
            }),
        )?
    } else {
        create_collab_task(
            store,
            &json!({
                "sessionId": session_id,
                "memberId": member.id,
                "title": payload_string(payload, "title").unwrap_or_else(|| "External ACP task".to_string()),
                "objective": payload_string(payload, "objective").or_else(|| payload_string(payload, "prompt")).unwrap_or_else(|| "Run external ACP member".to_string()),
                "description": payload_string(payload, "description").unwrap_or_default(),
                "status": "running",
                "taskType": "external_acp",
                "externalTaskRef": run_id,
                "metadata": {
                    "activeAcpRunId": run_id,
                    "backend": backend,
                    "command": command,
                    "args": args,
                }
            }),
        )?
    };

    if let Some(member_record) = store
        .collab_members
        .iter_mut()
        .find(|item| item.id == member.id && item.session_id == session_id)
    {
        member_record.current_task_id = Some(task.id.clone());
        member_record.status = "working".to_string();
        member_record.updated_at = now_i64();
    }

    let bridge = build_team_mcp_bridge_config(&json!({
        "sessionId": session_id,
        "memberId": member.id,
        "taskId": task.id,
        "command": payload_string(payload, "teamMcpCommand").unwrap_or_else(|| "redbox-team-mcp".to_string()),
    }));
    let mut env = payload_env(payload);
    if let Some(bridge_env) = bridge.server.env.clone() {
        env.extend(bridge_env);
    }
    env.insert(
        "REDBOX_TEAM_MCP_CONFIG".to_string(),
        serde_json::to_string(&bridge.acp_config).unwrap_or_default(),
    );

    let launch = AcpMemberRunLaunch {
        run_id: run_id.clone(),
        session_id: session_id.clone(),
        member_id: member.id.clone(),
        task_id: task.id.clone(),
        backend: backend.clone(),
        command: command.clone(),
        args: args.clone(),
        status: "running".to_string(),
        mcp_bridge_config: json!(bridge),
    };
    let plan = AcpExecutionPlan {
        run_id,
        session_id,
        member_id: member.id.clone(),
        task_id: task.id.clone(),
        backend,
        command,
        args,
        cwd: payload_string(payload, "cwd"),
        env,
        prompt: task_prompt(&task, payload),
        stdin_prompt: payload_bool(payload, "stdinPrompt", true),
        timeout_ms: payload_timeout_ms(payload),
    };
    Ok((
        AcpRunPreparation {
            launch,
            member,
            task,
        },
        plan,
    ))
}

fn run_acp_process(plan: &AcpExecutionPlan) -> AcpProcessOutput {
    if plan.command == "redbox-acp-fake" {
        return AcpProcessOutput {
            exit_code: Some(0),
            stdout: format!(
                "Fake ACP member completed run {} for task {}.\nPrompt:\n{}",
                plan.run_id, plan.task_id, plan.prompt
            ),
            stderr: String::new(),
            timed_out: false,
        };
    }

    let mut command = Command::new(&plan.command);
    command.args(&plan.args);
    if let Some(cwd) = plan.cwd.as_ref().filter(|value| !value.trim().is_empty()) {
        command.current_dir(PathBuf::from(cwd));
    }
    command.envs(&plan.env);
    command.stdin(Stdio::piped());
    command.stdout(Stdio::piped());
    command.stderr(Stdio::piped());
    configure_background_command(&mut command);

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            return AcpProcessOutput {
                exit_code: None,
                stdout: String::new(),
                stderr: error.to_string(),
                timed_out: false,
            };
        }
    };

    if plan.stdin_prompt {
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(plan.prompt.as_bytes());
            let _ = stdin.write_all(b"\n");
        }
    }

    let started_at = Instant::now();
    let mut timed_out = false;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if started_at.elapsed() > Duration::from_millis(plan.timeout_ms) {
                    timed_out = true;
                    let _ = child.kill();
                    break;
                }
                thread::sleep(Duration::from_millis(100));
            }
            Err(error) => {
                return AcpProcessOutput {
                    exit_code: None,
                    stdout: String::new(),
                    stderr: error.to_string(),
                    timed_out,
                };
            }
        }
    }

    match child.wait_with_output() {
        Ok(output) => AcpProcessOutput {
            exit_code: output.status.code(),
            stdout: String::from_utf8_lossy(&output.stdout).to_string(),
            stderr: String::from_utf8_lossy(&output.stderr).to_string(),
            timed_out,
        },
        Err(error) => AcpProcessOutput {
            exit_code: None,
            stdout: String::new(),
            stderr: error.to_string(),
            timed_out,
        },
    }
}

fn finalize_external_acp_run_in_store(
    store: &mut AppStore,
    plan: &AcpExecutionPlan,
    output: &AcpProcessOutput,
) -> Result<
    (
        CollabMemberRecord,
        CollabTaskRecord,
        CollabProgressReportRecord,
    ),
    String,
> {
    let success = !output.timed_out && output.exit_code == Some(0);
    let status = if success { "completed" } else { "failed" };
    let summary = if success {
        compact_text(
            output
                .stdout
                .trim()
                .is_empty()
                .then_some("External ACP member completed without stdout.")
                .unwrap_or_else(|| output.stdout.trim()),
            2000,
        )
    } else if output.timed_out {
        format!(
            "External ACP member timed out after {} ms. stderr: {}",
            plan.timeout_ms,
            compact_text(output.stderr.trim(), 1000)
        )
    } else {
        format!(
            "External ACP member failed with exit code {:?}. stderr: {}",
            output.exit_code,
            compact_text(output.stderr.trim(), 1000)
        )
    };
    let report = submit_collab_report(
        store,
        &json!({
            "sessionId": plan.session_id,
            "memberId": plan.member_id,
            "taskId": plan.task_id,
            "status": status,
            "memberStatus": status,
            "reportType": if success { "completion" } else { "failure" },
            "summary": summary,
            "progressPercent": if success { 100 } else { 0 },
            "blockers": if success { json!([]) } else { json!(["external_acp_process_failed"]) },
            "artifacts": [{
                "type": "process-output",
                "label": format!("{} {}", plan.backend, plan.run_id),
                "content": output.stdout,
                "stderr": output.stderr,
                "exitCode": output.exit_code,
                "timedOut": output.timed_out,
                "command": plan.command,
                "args": plan.args,
            }],
            "payload": {
                "runId": plan.run_id,
                "backend": plan.backend,
                "command": plan.command,
                "args": plan.args,
                "exitCode": output.exit_code,
                "timedOut": output.timed_out
            }
        }),
    )?;
    let task = update_collab_task(
        store,
        &json!({
            "taskId": plan.task_id,
            "status": status,
            "resultSummary": report.summary,
            "progressPercent": if success { 100 } else { 0 },
            "metadata": {
                "lastAcpRunId": plan.run_id,
                "backend": plan.backend,
                "exitCode": output.exit_code,
                "timedOut": output.timed_out
            }
        }),
    )?;
    let member = store
        .collab_members
        .iter_mut()
        .find(|item| item.id == plan.member_id && item.session_id == plan.session_id)
        .ok_or_else(|| "协作成员不存在".to_string())?;
    member.status = status.to_string();
    member.last_seen_at = Some(now_i64());
    member.last_activity_at = Some(now_i64());
    member.last_report_at = Some(now_i64());
    member.last_error = (!success).then(|| report.summary.clone());
    member.metadata = Some(merge_metadata(
        member.metadata.as_ref(),
        json!({
            "lastAcpRunId": plan.run_id,
            "lastExitCode": output.exit_code,
            "lastTimedOut": output.timed_out,
            "activeAcpRunId": Value::Null,
        }),
    ));
    member.updated_at = now_i64();
    Ok((member.clone(), task, report))
}

fn emit_run_started(app: &AppHandle, prep: &AcpRunPreparation) {
    emit_runtime_event(
        app,
        "runtime:collab-member-changed",
        None,
        None,
        json!({ "collabSessionId": prep.launch.session_id, "member": prep.member }),
    );
    emit_runtime_event(
        app,
        "runtime:collab-task-changed",
        None,
        None,
        json!({ "collabSessionId": prep.launch.session_id, "task": prep.task }),
    );
}

fn emit_run_finished(
    app: &AppHandle,
    session_id: &str,
    member: &CollabMemberRecord,
    task: &CollabTaskRecord,
    report: &CollabProgressReportRecord,
) {
    emit_runtime_event(
        app,
        "runtime:collab-report-submitted",
        None,
        None,
        json!({ "collabSessionId": session_id, "report": report }),
    );
    emit_runtime_event(
        app,
        "runtime:collab-member-changed",
        None,
        None,
        json!({ "collabSessionId": session_id, "member": member }),
    );
    emit_runtime_event(
        app,
        "runtime:collab-task-changed",
        None,
        None,
        json!({ "collabSessionId": session_id, "task": task }),
    );
}

pub fn start_external_acp_member_run(
    app: &AppHandle,
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let (prep, plan) = with_store_mut(state, |store| {
        prepare_external_acp_run_in_store(store, payload)
    })?;
    emit_run_started(app, &prep);
    let app_handle = app.clone();
    thread::spawn(move || {
        let output = run_acp_process(&plan);
        let state = app_handle.state::<AppState>();
        match with_store_mut(&state, |store| {
            finalize_external_acp_run_in_store(store, &plan, &output)
        }) {
            Ok((member, task, report)) => {
                emit_run_finished(&app_handle, &plan.session_id, &member, &task, &report);
            }
            Err(error) => {
                emit_runtime_event(
                    &app_handle,
                    "runtime:collab-report-submitted",
                    None,
                    None,
                    json!({
                        "collabSessionId": plan.session_id,
                        "error": error,
                        "runId": plan.run_id
                    }),
                );
            }
        }
    });
    Ok(json!(prep.launch))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::runtime::create_collab_session;

    #[test]
    fn external_acp_run_prepares_member_and_task() {
        let mut store = AppStore::default();
        let session = create_collab_session(&mut store, &json!({ "objective": "acp" })).unwrap();
        let (prep, plan) = prepare_external_acp_run_in_store(
            &mut store,
            &json!({
                "sessionId": session.id,
                "backend": "fake",
                "displayName": "Fake ACP",
                "title": "Run fake task",
                "prompt": "do the work"
            }),
        )
        .unwrap();
        assert_eq!(prep.member.source_kind, "external_acp");
        assert_eq!(prep.task.status, "running");
        assert_eq!(plan.command, "redbox-acp-fake");
        assert_eq!(
            plan.env.get("REDBOX_TEAM_SESSION_ID").map(String::as_str),
            Some(session.id.as_str())
        );
    }

    #[test]
    fn external_acp_run_finalizes_report_and_task() {
        let mut store = AppStore::default();
        let session = create_collab_session(&mut store, &json!({ "objective": "acp" })).unwrap();
        let (_prep, plan) = prepare_external_acp_run_in_store(
            &mut store,
            &json!({
                "sessionId": session.id,
                "backend": "fake",
                "prompt": "do the work"
            }),
        )
        .unwrap();
        let output = AcpProcessOutput {
            exit_code: Some(0),
            stdout: "finished".to_string(),
            stderr: String::new(),
            timed_out: false,
        };
        let (member, task, report) =
            finalize_external_acp_run_in_store(&mut store, &plan, &output).unwrap();
        assert_eq!(member.status, "completed");
        assert_eq!(task.status, "completed");
        assert_eq!(report.status, "completed");
        assert_eq!(task.progress_percent, Some(100));
    }
}
