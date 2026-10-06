use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::{AppHandle, State};

use crate::events::emit_runtime_event;
use crate::persistence::{with_store, with_store_mut};
use crate::runtime::{append_session_checkpoint, RuntimeHookRecord};
use crate::store::mcp_tools as mcp_tools_store;
use crate::tools::router::PreparedToolCall;
use crate::{append_session_transcript, workspace_root, AppState};

#[derive(Debug, Clone)]
struct CommandHook {
    id: String,
    event: String,
    command: String,
    timeout_sec: u64,
    plugin_root: Option<String>,
    plugin_data_root: Option<String>,
    source_path: Option<String>,
    source_relative_path: Option<String>,
}

#[derive(Debug)]
struct CommandHookRun {
    hook_id: String,
    event: String,
    source_path: Option<String>,
    source_relative_path: Option<String>,
    started_at: i64,
    completed_at: i64,
    duration_ms: i64,
    exit_code: Option<i32>,
    stdout: String,
    stderr: String,
    error: Option<String>,
    completion_order: usize,
}

#[derive(Debug, Default)]
struct PreToolUseEffect {
    block_reason: Option<String>,
    additional_context: Option<String>,
    updated_input: Option<Value>,
}

#[derive(Debug, Default)]
struct PostToolUseEffect {
    stop_reason: Option<String>,
    feedback_message: Option<String>,
    additional_context: Option<String>,
}

pub fn run_pre_tool_use_hooks(
    app: &AppHandle,
    state: &State<'_, AppState>,
    session_id: Option<&str>,
    tool_call_id: Option<&str>,
    prepared: &PreparedToolCall,
    model_config: Option<&Value>,
) -> Result<Option<Value>, String> {
    let hooks = matching_command_hooks(state, "PreToolUse", &prepared.name)?;
    if hooks.is_empty() {
        return Ok(None);
    }

    let call_id = tool_call_id.unwrap_or(prepared.name.as_str());
    let input = hook_input_json(
        "PreToolUse",
        session_id,
        call_id,
        &prepared.name,
        &prepared.arguments,
        None,
        model_config,
        state,
    );
    let cwd = hook_cwd(state);
    let runs = run_command_hooks(&hooks, &input, &cwd);
    let mut effects = Vec::new();
    for run in &runs {
        let effect = parse_pre_tool_use_effect(&run);
        record_hook_run(
            app,
            state,
            session_id,
            call_id,
            &prepared.name,
            &run,
            effect
                .block_reason
                .as_deref()
                .or(effect.additional_context.as_deref()),
        );
        effects.push((run, effect));
    }
    if let Some((run, effect)) = effects
        .iter()
        .find(|(_, effect)| effect.block_reason.is_some())
    {
        let reason = effect.block_reason.clone().unwrap_or_default();
        return Err(json!({
            "ok": false,
            "tool": prepared.name,
            "error": {
                "code": "CODEX_PRE_TOOL_HOOK_BLOCKED",
                "message": reason,
                "retryable": false,
                "hookId": run.hook_id,
            }
        })
        .to_string());
    }
    Ok(effects
        .into_iter()
        .filter_map(|(run, effect)| {
            effect
                .updated_input
                .map(|updated_input| (run.completion_order, updated_input))
        })
        .max_by_key(|(completion_order, _)| *completion_order)
        .map(|(_, updated_input)| updated_input))
}

pub fn run_post_tool_use_hooks(
    app: &AppHandle,
    state: &State<'_, AppState>,
    session_id: Option<&str>,
    tool_call_id: Option<&str>,
    prepared: &PreparedToolCall,
    tool_response: &Value,
    model_config: Option<&Value>,
) -> Option<String> {
    let Ok(hooks) = matching_command_hooks(state, "PostToolUse", &prepared.name) else {
        return None;
    };
    if hooks.is_empty() {
        return None;
    }

    let call_id = tool_call_id.unwrap_or(prepared.name.as_str());
    let input = hook_input_json(
        "PostToolUse",
        session_id,
        call_id,
        &prepared.name,
        &prepared.arguments,
        Some(tool_response),
        model_config,
        state,
    );
    let cwd = hook_cwd(state);
    let mut stop_reason = None;
    let runs = run_command_hooks(&hooks, &input, &cwd);
    for run in runs {
        let effect = parse_post_tool_use_effect(&run);
        record_hook_run(
            app,
            state,
            session_id,
            call_id,
            &prepared.name,
            &run,
            effect
                .stop_reason
                .as_deref()
                .or(effect.feedback_message.as_deref())
                .or(effect.additional_context.as_deref()),
        );
        if stop_reason.is_none() {
            stop_reason = effect.stop_reason;
        }
    }
    stop_reason
}

fn run_command_hooks(hooks: &[CommandHook], input_json: &str, cwd: &Path) -> Vec<CommandHookRun> {
    let (sender, receiver) = mpsc::channel();
    for (configured_order, hook) in hooks.iter().cloned().enumerate() {
        let sender = sender.clone();
        let input_json = input_json.to_string();
        let cwd = cwd.to_path_buf();
        thread::spawn(move || {
            let run = run_command_hook(&hook, &input_json, &cwd);
            let _ = sender.send((configured_order, run));
        });
    }
    drop(sender);

    let mut completed = Vec::new();
    let mut completion_order = 0usize;
    for (configured_order, mut run) in receiver.iter().take(hooks.len()) {
        run.completion_order = completion_order;
        completion_order += 1;
        completed.push((configured_order, run));
    }
    completed.sort_by_key(|(configured_order, _)| *configured_order);
    completed.into_iter().map(|(_, run)| run).collect()
}

fn matching_command_hooks(
    state: &State<'_, AppState>,
    event: &str,
    tool_name: &str,
) -> Result<Vec<CommandHook>, String> {
    with_store(state, |store| {
        Ok(mcp_tools_store::list_runtime_hooks(&store)
            .into_iter()
            .filter(|hook| hook.enabled.unwrap_or(true))
            .filter(|hook| hook.event == event)
            .filter(|hook| hook.r#type == "command")
            .filter(|hook| hook.r#async != Some(true))
            .filter(|hook| matches_hook_matcher(hook.matcher.as_deref(), tool_name))
            .filter_map(command_hook_from_record)
            .collect::<Vec<_>>())
    })
}

fn command_hook_from_record(record: RuntimeHookRecord) -> Option<CommandHook> {
    let command = command_for_platform(&record)?;
    Some(CommandHook {
        id: record.id,
        event: record.event,
        command,
        timeout_sec: record.timeout_sec.unwrap_or(600).max(1),
        plugin_root: record.plugin_root,
        plugin_data_root: record.plugin_data_root,
        source_path: record.source_path,
        source_relative_path: record.source_relative_path,
    })
}

fn command_for_platform(record: &RuntimeHookRecord) -> Option<String> {
    #[cfg(windows)]
    {
        record
            .command_windows
            .as_deref()
            .or(record.command.as_deref())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToString::to_string)
    }

    #[cfg(not(windows))]
    {
        record
            .command
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToString::to_string)
    }
}

fn matches_hook_matcher(matcher: Option<&str>, tool_name: &str) -> bool {
    let Some(matcher) = matcher else {
        return true;
    };
    if matcher.is_empty() || matcher == "*" {
        return true;
    }
    if matcher
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '|')
    {
        return matcher.split('|').any(|candidate| candidate == tool_name);
    }
    regex::Regex::new(matcher)
        .map(|regex| regex.is_match(tool_name))
        .unwrap_or(false)
}

fn hook_input_json(
    event: &str,
    session_id: Option<&str>,
    tool_call_id: &str,
    tool_name: &str,
    tool_input: &Value,
    tool_response: Option<&Value>,
    model_config: Option<&Value>,
    state: &State<'_, AppState>,
) -> String {
    let mut object = serde_json::Map::new();
    object.insert(
        "session_id".to_string(),
        json!(session_id.unwrap_or("interactive")),
    );
    object.insert("turn_id".to_string(), json!(tool_call_id));
    object.insert("transcript_path".to_string(), Value::Null);
    object.insert(
        "cwd".to_string(),
        json!(hook_cwd(state).display().to_string()),
    );
    object.insert("hook_event_name".to_string(), json!(event));
    object.insert("model".to_string(), json!(model_name(model_config)));
    object.insert("permission_mode".to_string(), json!("default"));
    object.insert("tool_name".to_string(), json!(tool_name));
    object.insert("tool_input".to_string(), tool_input.clone());
    object.insert("tool_use_id".to_string(), json!(tool_call_id));
    if let Some(tool_response) = tool_response {
        object.insert("tool_response".to_string(), tool_response.clone());
    }
    Value::Object(object).to_string()
}

fn model_name(model_config: Option<&Value>) -> String {
    model_config
        .and_then(|value| {
            value
                .get("model")
                .or_else(|| value.get("modelName"))
                .or_else(|| value.get("name"))
        })
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("redbox")
        .to_string()
}

fn hook_cwd(state: &State<'_, AppState>) -> PathBuf {
    workspace_root(state).unwrap_or_else(|_| PathBuf::from("."))
}

fn run_command_hook(hook: &CommandHook, input_json: &str, cwd: &Path) -> CommandHookRun {
    let started_at = crate::now_i64();
    let started = Instant::now();
    let mut command = default_shell_command();
    command
        .arg(substitute_plugin_env(&hook.command, hook))
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .envs(command_hook_env(hook));

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            return CommandHookRun {
                hook_id: hook.id.clone(),
                event: hook.event.clone(),
                source_path: hook.source_path.clone(),
                source_relative_path: hook.source_relative_path.clone(),
                started_at,
                completed_at: crate::now_i64(),
                duration_ms: elapsed_ms(started),
                exit_code: None,
                stdout: String::new(),
                stderr: String::new(),
                error: Some(error.to_string()),
                completion_order: 0,
            };
        }
    };

    if let Some(mut stdin) = child.stdin.take() {
        if let Err(error) = stdin.write_all(input_json.as_bytes()) {
            let _ = child.kill();
            return CommandHookRun {
                hook_id: hook.id.clone(),
                event: hook.event.clone(),
                source_path: hook.source_path.clone(),
                source_relative_path: hook.source_relative_path.clone(),
                started_at,
                completed_at: crate::now_i64(),
                duration_ms: elapsed_ms(started),
                exit_code: None,
                stdout: String::new(),
                stderr: String::new(),
                error: Some(format!("failed to write hook stdin: {error}")),
                completion_order: 0,
            };
        }
    }

    let stdout_handle = child.stdout.take().map(read_pipe_to_string);
    let stderr_handle = child.stderr.take().map(read_pipe_to_string);
    let timeout_at = Instant::now() + Duration::from_secs(hook.timeout_sec);
    let mut exit_code = None;
    let mut error = None;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                exit_code = status.code();
                break;
            }
            Ok(None) if Instant::now() >= timeout_at => {
                let _ = child.kill();
                let _ = child.wait();
                error = Some(format!("hook timed out after {}s", hook.timeout_sec));
                break;
            }
            Ok(None) => thread::sleep(Duration::from_millis(20)),
            Err(wait_error) => {
                error = Some(wait_error.to_string());
                break;
            }
        }
    }
    let stdout = stdout_handle
        .and_then(|handle| handle.join().ok())
        .unwrap_or_default();
    let stderr = stderr_handle
        .and_then(|handle| handle.join().ok())
        .unwrap_or_default();

    CommandHookRun {
        hook_id: hook.id.clone(),
        event: hook.event.clone(),
        source_path: hook.source_path.clone(),
        source_relative_path: hook.source_relative_path.clone(),
        started_at,
        completed_at: crate::now_i64(),
        duration_ms: elapsed_ms(started),
        exit_code,
        stdout,
        stderr,
        error,
        completion_order: 0,
    }
}

fn read_pipe_to_string<T>(mut pipe: T) -> thread::JoinHandle<String>
where
    T: Read + Send + 'static,
{
    thread::spawn(move || {
        let mut output = String::new();
        let _ = pipe.read_to_string(&mut output);
        output
    })
}

fn default_shell_command() -> Command {
    #[cfg(windows)]
    {
        let comspec = std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string());
        let mut command = Command::new(comspec);
        command.arg("/C");
        command
    }

    #[cfg(not(windows))]
    {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
        let mut command = Command::new(shell);
        command.arg("-lc");
        command
    }
}

fn command_hook_env(hook: &CommandHook) -> Vec<(String, String)> {
    let mut env = Vec::new();
    if let Some(plugin_root) = hook.plugin_root.as_ref() {
        env.push(("PLUGIN_ROOT".to_string(), plugin_root.clone()));
        env.push(("CLAUDE_PLUGIN_ROOT".to_string(), plugin_root.clone()));
    }
    if let Some(plugin_data_root) = hook.plugin_data_root.as_ref() {
        env.push(("PLUGIN_DATA".to_string(), plugin_data_root.clone()));
        env.push(("CLAUDE_PLUGIN_DATA".to_string(), plugin_data_root.clone()));
    }
    env
}

fn substitute_plugin_env(command: &str, hook: &CommandHook) -> String {
    let mut command = command.to_string();
    if let Some(plugin_root) = hook.plugin_root.as_ref() {
        command = command.replace("${PLUGIN_ROOT}", plugin_root);
        command = command.replace("${CLAUDE_PLUGIN_ROOT}", plugin_root);
    }
    if let Some(plugin_data_root) = hook.plugin_data_root.as_ref() {
        command = command.replace("${PLUGIN_DATA}", plugin_data_root);
        command = command.replace("${CLAUDE_PLUGIN_DATA}", plugin_data_root);
    }
    command
}

fn parse_pre_tool_use_effect(run: &CommandHookRun) -> PreToolUseEffect {
    if run.error.is_some() {
        return PreToolUseEffect::default();
    }
    match run.exit_code {
        Some(0) => parse_pre_tool_use_stdout(&run.stdout),
        Some(2) => PreToolUseEffect {
            block_reason: trimmed(&run.stderr),
            ..PreToolUseEffect::default()
        },
        _ => PreToolUseEffect::default(),
    }
}

fn parse_pre_tool_use_stdout(stdout: &str) -> PreToolUseEffect {
    let Some(value) = parse_hook_stdout(stdout) else {
        return PreToolUseEffect::default();
    };
    let hook_specific = value
        .get("hookSpecificOutput")
        .or_else(|| value.get("hook_specific_output"));
    let block_reason = hook_specific
        .and_then(|output| {
            (string_field(output, "permissionDecision").as_deref() == Some("deny"))
                .then(|| {
                    string_field(output, "permissionDecisionReason")
                        .or_else(|| string_field(output, "permission_decision_reason"))
                })
                .flatten()
        })
        .or_else(|| {
            (string_field(&value, "decision").as_deref() == Some("block"))
                .then(|| string_field(&value, "reason"))
                .flatten()
        })
        .and_then(|reason| trimmed(&reason));
    let updated_input = hook_specific.and_then(|output| {
        (string_field(output, "permissionDecision").as_deref() == Some("allow"))
            .then(|| {
                output
                    .get("updatedInput")
                    .or_else(|| output.get("updated_input"))
            })
            .flatten()
            .cloned()
    });
    let additional_context = hook_specific
        .and_then(|output| {
            string_field(output, "additionalContext")
                .or_else(|| string_field(output, "additional_context"))
        })
        .and_then(|text| trimmed(&text));
    PreToolUseEffect {
        block_reason,
        additional_context,
        updated_input,
    }
}

fn parse_post_tool_use_effect(run: &CommandHookRun) -> PostToolUseEffect {
    if run.error.is_some() {
        return PostToolUseEffect::default();
    }
    match run.exit_code {
        Some(0) => parse_post_tool_use_stdout(&run.stdout),
        Some(2) => PostToolUseEffect {
            feedback_message: trimmed(&run.stderr),
            ..PostToolUseEffect::default()
        },
        _ => PostToolUseEffect::default(),
    }
}

fn parse_post_tool_use_stdout(stdout: &str) -> PostToolUseEffect {
    let Some(value) = parse_hook_stdout(stdout) else {
        return PostToolUseEffect::default();
    };
    let hook_specific = value
        .get("hookSpecificOutput")
        .or_else(|| value.get("hook_specific_output"));
    let stop_reason = (value.get("continue").and_then(Value::as_bool) == Some(false)).then(|| {
        string_field(&value, "stopReason")
            .or_else(|| string_field(&value, "stop_reason"))
            .and_then(|text| trimmed(&text))
            .unwrap_or_else(|| "PostToolUse hook requested the turn stop".to_string())
    });
    let feedback_message = (string_field(&value, "decision").as_deref() == Some("block"))
        .then(|| string_field(&value, "reason"))
        .flatten()
        .and_then(|text| trimmed(&text));
    let additional_context = hook_specific
        .and_then(|output| {
            string_field(output, "additionalContext")
                .or_else(|| string_field(output, "additional_context"))
        })
        .and_then(|text| trimmed(&text));
    PostToolUseEffect {
        stop_reason,
        feedback_message,
        additional_context,
    }
}

fn parse_hook_stdout(stdout: &str) -> Option<Value> {
    let trimmed = stdout.trim();
    if trimmed.is_empty() {
        return None;
    }
    let value = serde_json::from_str::<Value>(trimmed).ok()?;
    value.is_object().then_some(value)
}

fn string_field(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(ToString::to_string)
}

fn trimmed(value: &str) -> Option<String> {
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_string())
}

fn elapsed_ms(started: Instant) -> i64 {
    started.elapsed().as_millis().try_into().unwrap_or(i64::MAX)
}

fn record_hook_run(
    app: &AppHandle,
    state: &State<'_, AppState>,
    session_id: Option<&str>,
    tool_call_id: &str,
    tool_name: &str,
    run: &CommandHookRun,
    message: Option<&str>,
) {
    let success = run.error.is_none() && run.exit_code == Some(0);
    emit_runtime_event(
        app,
        "runtime:codex-hook-run",
        session_id,
        None,
        json!({
            "hookId": run.hook_id,
            "event": run.event,
            "toolCallId": tool_call_id,
            "toolName": tool_name,
            "sourcePath": run.source_path,
            "sourceRelativePath": run.source_relative_path,
            "success": success,
            "exitCode": run.exit_code,
            "error": run.error,
            "durationMs": run.duration_ms,
            "message": message,
        }),
    );
    let Some(session_id) = session_id else {
        return;
    };
    let _ = with_store_mut(state, |store| {
        let checkpoint_type = match run.event.as_str() {
            "PreToolUse" => "hook.pre_tool_use",
            "PostToolUse" => "hook.post_tool_use",
            _ => "hook.run",
        };
        let content = format!(
            "{} {} {}",
            tool_name,
            if success { "ok" } else { "failed_or_blocked" },
            checkpoint_type
        );
        let payload = json!({
            "hookId": run.hook_id,
            "event": run.event,
            "toolCallId": tool_call_id,
            "toolName": tool_name,
            "sourcePath": run.source_path,
            "sourceRelativePath": run.source_relative_path,
            "startedAt": run.started_at,
            "completedAt": run.completed_at,
            "durationMs": run.duration_ms,
            "exitCode": run.exit_code,
            "stdout": run.stdout,
            "stderr": run.stderr,
            "error": run.error,
            "message": message,
        });
        append_session_transcript(
            store,
            session_id,
            checkpoint_type,
            "tool",
            content.clone(),
            Some(payload.clone()),
        );
        append_session_checkpoint(store, session_id, checkpoint_type, content, Some(payload));
        Ok(())
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exact_matcher_uses_codex_pipe_semantics() {
        assert!(matches_hook_matcher(Some("bash|shell"), "bash"));
        assert!(matches_hook_matcher(Some("bash|shell"), "shell"));
        assert!(!matches_hook_matcher(Some("bash|shell"), "workflow"));
    }

    #[test]
    fn regex_matcher_matches_tool_name() {
        assert!(matches_hook_matcher(Some("mcp__.*"), "mcp__demo__search"));
        assert!(!matches_hook_matcher(Some("mcp__.*"), "workflow"));
    }

    #[test]
    fn parses_pre_tool_use_block_output() {
        let effect =
            parse_pre_tool_use_stdout(r#"{"decision":"block","reason":"Do not run this command"}"#);
        assert_eq!(
            effect.block_reason.as_deref(),
            Some("Do not run this command")
        );
    }

    #[test]
    fn parses_pre_tool_use_updated_input() {
        let effect = parse_pre_tool_use_stdout(
            r#"{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","updatedInput":{"action":"safe"}}}"#,
        );
        assert_eq!(
            effect
                .updated_input
                .as_ref()
                .and_then(|value| value.get("action")),
            Some(&json!("safe"))
        );
    }

    #[test]
    fn parses_post_tool_use_continue_false_stop() {
        let effect =
            parse_post_tool_use_stdout(r#"{"continue":false,"stopReason":"Stop after this tool"}"#);
        assert_eq!(effect.stop_reason.as_deref(), Some("Stop after this tool"));

        let effect = parse_post_tool_use_stdout(r#"{"continue":false}"#);
        assert_eq!(
            effect.stop_reason.as_deref(),
            Some("PostToolUse hook requested the turn stop")
        );
    }

    #[test]
    #[cfg(not(windows))]
    fn command_hook_runs_with_stdin_and_plugin_data_env() {
        let nonce = crate::now_i64();
        let root = std::env::temp_dir().join(format!("redbox-hook-test-{nonce}"));
        let data_root = root.join("data");
        std::fs::create_dir_all(&data_root).expect("create data root");
        let hook = CommandHook {
            id: "hook-test".to_string(),
            event: "PreToolUse".to_string(),
            command: "cat > ${PLUGIN_DATA}/stdin.json; printf '%s' '{\"decision\":\"block\",\"reason\":\"blocked by hook\"}'".to_string(),
            timeout_sec: 5,
            plugin_root: Some(root.display().to_string()),
            plugin_data_root: Some(data_root.display().to_string()),
            source_path: None,
            source_relative_path: Some("hooks/hooks.json".to_string()),
        };

        let run = run_command_hook(&hook, r#"{"tool_name":"shell"}"#, &root);

        assert_eq!(run.exit_code, Some(0));
        assert_eq!(
            std::fs::read_to_string(data_root.join("stdin.json"))
                .ok()
                .as_deref(),
            Some(r#"{"tool_name":"shell"}"#)
        );
        let effect = parse_pre_tool_use_effect(&run);
        assert_eq!(effect.block_reason.as_deref(), Some("blocked by hook"));

        let _ = std::fs::remove_dir_all(root);
    }
}
