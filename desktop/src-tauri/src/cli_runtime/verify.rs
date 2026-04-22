use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::{json, Value};
use tauri::State;

use crate::cli_runtime::{
    replace_cli_verification_records, upsert_cli_execution_record, CliExecuteRequest,
    CliExecutionRecord, CliExecutionStatus, CliVerificationRecord, CliVerificationStatus,
    CliVerifierKind, CliVerifyRule,
};
use crate::process_utils::configure_background_command;
use crate::{make_id, now_i64, AppState};

#[derive(Debug, Clone)]
pub struct CliVerificationOutcome {
    pub execution: CliExecutionRecord,
    pub verifications: Vec<CliVerificationRecord>,
    pub summary: String,
}

#[derive(Debug)]
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
        .ok_or_else(|| "custom verification command requires argv[0]".to_string())?;
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

fn read_optional_text(path: Option<&str>) -> Result<String, String> {
    let Some(path) = path else {
        return Ok(String::new());
    };
    match fs::read_to_string(path) {
        Ok(content) => Ok(content),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(error) => Err(error.to_string()),
    }
}

fn resolve_rule_path(base: &Path, target: &str) -> PathBuf {
    let path = PathBuf::from(target);
    if path.is_absolute() {
        path
    } else {
        base.join(path)
    }
}

fn select_output_stream(stdout: &str, stderr: &str, stream: Option<&str>) -> String {
    match stream.unwrap_or("").trim().to_ascii_lowercase().as_str() {
        "stdout" => stdout.to_string(),
        "stderr" => stderr.to_string(),
        _ => {
            if stdout.is_empty() {
                stderr.to_string()
            } else if stderr.is_empty() {
                stdout.to_string()
            } else {
                format!("{stdout}\n{stderr}")
            }
        }
    }
}

fn verification_record(
    execution_id: &str,
    verifier: CliVerifierKind,
    status: CliVerificationStatus,
    summary: String,
    detail: Value,
) -> CliVerificationRecord {
    CliVerificationRecord {
        id: make_id("cli-verify"),
        execution_id: execution_id.to_string(),
        verifier,
        status,
        summary,
        detail: Some(detail),
        created_at: now_i64(),
    }
}

fn verify_rule(
    execution: &CliExecutionRecord,
    rule: &CliVerifyRule,
    stdout: &str,
    stderr: &str,
) -> Result<CliVerificationRecord, String> {
    let cwd = Path::new(&execution.cwd);
    let default_env = std::env::vars().collect::<BTreeMap<String, String>>();

    let record = match rule {
        CliVerifyRule::ExitCode { expected } => {
            let expected = expected.unwrap_or(0);
            let passed = execution.exit_code == Some(expected);
            verification_record(
                &execution.id,
                CliVerifierKind::ExitCode,
                if passed {
                    CliVerificationStatus::Passed
                } else {
                    CliVerificationStatus::Failed
                },
                if passed {
                    format!("退出码校验通过：{expected}")
                } else {
                    format!(
                        "退出码校验失败：期望 {expected}，实际 {}",
                        execution
                            .exit_code
                            .map(|value| value.to_string())
                            .unwrap_or_else(|| "unknown".to_string())
                    )
                },
                json!({
                    "expected": expected,
                    "actual": execution.exit_code,
                }),
            )
        }
        CliVerifyRule::FileExists { path } => {
            let resolved = resolve_rule_path(cwd, path);
            let passed = resolved.exists();
            verification_record(
                &execution.id,
                CliVerifierKind::FileExists,
                if passed {
                    CliVerificationStatus::Passed
                } else {
                    CliVerificationStatus::Failed
                },
                if passed {
                    format!("产物存在：{}", resolved.to_string_lossy())
                } else {
                    format!("未找到产物：{}", resolved.to_string_lossy())
                },
                json!({
                    "path": resolved,
                    "exists": passed,
                }),
            )
        }
        CliVerifyRule::OutputContains { stream, text } => {
            let content = select_output_stream(stdout, stderr, stream.as_deref());
            let passed = content.contains(text);
            verification_record(
                &execution.id,
                CliVerifierKind::OutputContains,
                if passed {
                    CliVerificationStatus::Passed
                } else {
                    CliVerificationStatus::Failed
                },
                if passed {
                    format!("输出命中关键字：{text}")
                } else {
                    format!("输出未命中关键字：{text}")
                },
                json!({
                    "stream": stream,
                    "text": text,
                }),
            )
        }
        CliVerifyRule::JsonSchema {
            stream,
            required_keys,
        } => {
            let content = select_output_stream(stdout, stderr, stream.as_deref());
            let parsed = serde_json::from_str::<Value>(content.trim()).ok();
            let missing_keys = match parsed.as_ref().and_then(Value::as_object) {
                Some(object) => required_keys
                    .iter()
                    .filter(|key| !object.contains_key(key.as_str()))
                    .cloned()
                    .collect::<Vec<_>>(),
                None => required_keys.clone(),
            };
            let passed = parsed.is_some() && missing_keys.is_empty();
            verification_record(
                &execution.id,
                CliVerifierKind::JsonSchema,
                if passed {
                    CliVerificationStatus::Passed
                } else {
                    CliVerificationStatus::Failed
                },
                if passed {
                    format!("JSON 校验通过：{} 个 key", required_keys.len())
                } else if parsed.is_none() {
                    "JSON 校验失败：输出不是合法 JSON 对象".to_string()
                } else {
                    format!("JSON 校验失败：缺少 key {}", missing_keys.join(", "))
                },
                json!({
                    "stream": stream,
                    "requiredKeys": required_keys,
                    "missingKeys": missing_keys,
                }),
            )
        }
        CliVerifyRule::CustomCommand { argv, cwd } => {
            let command_cwd = cwd
                .as_deref()
                .map(|value| resolve_rule_path(Path::new(&execution.cwd), value))
                .unwrap_or_else(|| PathBuf::from(&execution.cwd));
            let output = run_local_command_capture(argv, &command_cwd, &default_env)?;
            let passed = output.exit_code == Some(0);
            verification_record(
                &execution.id,
                CliVerifierKind::CustomCommand,
                if passed {
                    CliVerificationStatus::Passed
                } else {
                    CliVerificationStatus::Failed
                },
                if passed {
                    "自定义校验命令执行成功".to_string()
                } else {
                    format!(
                        "自定义校验命令失败：退出码 {}",
                        output
                            .exit_code
                            .map(|value| value.to_string())
                            .unwrap_or_else(|| "unknown".to_string())
                    )
                },
                json!({
                    "argv": argv,
                    "cwd": command_cwd,
                    "exitCode": output.exit_code,
                    "stdout": String::from_utf8_lossy(&output.stdout),
                    "stderr": String::from_utf8_lossy(&output.stderr),
                }),
            )
        }
    };

    Ok(record)
}

fn verification_summary(records: &[CliVerificationRecord]) -> (CliVerificationStatus, String) {
    if records.is_empty() {
        return (
            CliVerificationStatus::Skipped,
            "未提供校验规则，跳过结果校验".to_string(),
        );
    }
    let passed = records
        .iter()
        .filter(|item| item.status == CliVerificationStatus::Passed)
        .count();
    let failed = records
        .iter()
        .filter(|item| item.status == CliVerificationStatus::Failed)
        .count();
    if failed > 0 {
        let first_failure = records
            .iter()
            .find(|item| item.status == CliVerificationStatus::Failed)
            .map(|item| item.summary.as_str())
            .unwrap_or("校验失败");
        (
            CliVerificationStatus::Failed,
            format!("校验失败：{passed}/{} 通过。{first_failure}", records.len()),
        )
    } else {
        (
            CliVerificationStatus::Passed,
            format!("校验通过：{} 条规则全部通过", records.len()),
        )
    }
}

pub fn run_cli_verification(
    state: &State<'_, AppState>,
    execution: CliExecutionRecord,
    rules: &[CliVerifyRule],
) -> Result<CliVerificationOutcome, String> {
    if matches!(
        execution.status,
        CliExecutionStatus::Pending
            | CliExecutionStatus::Running
            | CliExecutionStatus::AwaitingEscalation
    ) {
        return Err("cli execution is not finished yet".to_string());
    }

    let stdout = read_optional_text(execution.stdout_path.as_deref())?;
    let stderr = read_optional_text(execution.stderr_path.as_deref())?;
    let mut verification_records = Vec::with_capacity(rules.len());
    for rule in rules {
        verification_records.push(verify_rule(&execution, rule, &stdout, &stderr)?);
    }
    let (verification_status, summary) = verification_summary(&verification_records);
    let mut updated_execution = execution.clone();
    updated_execution.verification_status = verification_status;
    let updated_execution = upsert_cli_execution_record(state, updated_execution)?;
    let stored_records = replace_cli_verification_records(state, verification_records)?;
    Ok(CliVerificationOutcome {
        execution: updated_execution,
        verifications: stored_records,
        summary,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_execution(stdout_path: &Path, stderr_path: &Path) -> CliExecutionRecord {
        CliExecutionRecord {
            id: "cli-exec-test".to_string(),
            session_id: "session-test".to_string(),
            task_id: None,
            runtime_id: None,
            environment_id: "cli-env-app-global".to_string(),
            tool_id: Some("node".to_string()),
            command: vec!["node".to_string(), "--version".to_string()],
            cwd: std::env::temp_dir().to_string_lossy().to_string(),
            status: CliExecutionStatus::Completed,
            exit_code: Some(0),
            stdout_path: Some(stdout_path.to_string_lossy().to_string()),
            stderr_path: Some(stderr_path.to_string_lossy().to_string()),
            artifact_paths: Vec::new(),
            verification_status: CliVerificationStatus::Unknown,
            started_at: Some(now_i64()),
            finished_at: Some(now_i64()),
            metadata: None,
        }
    }

    #[test]
    fn verify_rule_supports_output_contains_and_json_schema() {
        let temp_root = std::env::temp_dir().join(format!("redbox-cli-verify-{}", now_i64()));
        fs::create_dir_all(&temp_root).expect("temp dir should exist");
        let stdout_path = temp_root.join("stdout.log");
        let stderr_path = temp_root.join("stderr.log");
        fs::write(&stdout_path, r#"{"ok":true,"source":"cli-runtime"}"#)
            .expect("stdout should write");
        fs::write(&stderr_path, "").expect("stderr should write");
        let execution = sample_execution(&stdout_path, &stderr_path);

        let output_contains = verify_rule(
            &execution,
            &CliVerifyRule::OutputContains {
                stream: Some("stdout".to_string()),
                text: "\"ok\":true".to_string(),
            },
            r#"{"ok":true,"source":"cli-runtime"}"#,
            "",
        )
        .expect("output verification should work");
        assert_eq!(output_contains.status, CliVerificationStatus::Passed);

        let json_schema = verify_rule(
            &execution,
            &CliVerifyRule::JsonSchema {
                stream: Some("stdout".to_string()),
                required_keys: vec!["ok".to_string(), "source".to_string()],
            },
            r#"{"ok":true,"source":"cli-runtime"}"#,
            "",
        )
        .expect("json verification should work");
        assert_eq!(json_schema.status, CliVerificationStatus::Passed);

        let _ = fs::remove_dir_all(&temp_root);
    }

    #[test]
    fn verification_summary_reports_failure() {
        let records = vec![
            verification_record(
                "cli-exec-test",
                CliVerifierKind::ExitCode,
                CliVerificationStatus::Passed,
                "ok".to_string(),
                json!({}),
            ),
            verification_record(
                "cli-exec-test",
                CliVerifierKind::FileExists,
                CliVerificationStatus::Failed,
                "missing".to_string(),
                json!({}),
            ),
        ];
        let (status, summary) = verification_summary(&records);
        assert_eq!(status, CliVerificationStatus::Failed);
        assert!(summary.contains("校验失败"));
    }
}
