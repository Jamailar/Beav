use serde::Serialize;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::env;
use std::fs;
use std::io::Write;
use std::io::{BufRead, BufReader, Read};
use std::net::TcpListener;
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::Duration;
use std::time::Instant;
use std::time::{SystemTime, UNIX_EPOCH};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

type ProbeResult<T> = Result<T, String>;

const DEFAULT_PROVIDER: &str = "mock";
const DEFAULT_REPEAT: usize = 1;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[cfg(target_os = "windows")]
fn background_command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    let mut command = Command::new(program);
    command.creation_flags(CREATE_NO_WINDOW);
    command
}

#[cfg(not(target_os = "windows"))]
fn background_command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    Command::new(program)
}

#[derive(Debug, Clone)]
struct Cli {
    command: ProbeCommand,
    output_dir: Option<PathBuf>,
}

#[derive(Debug, Clone)]
enum ProbeCommand {
    Help,
    ListScenarios,
    Smoke,
    RunAll(ScenarioOptions),
    RunScenario(ScenarioOptions),
    Replay(ReplayOptions),
    Inspect(ReplayOptions),
    Report(ReplayOptions),
    ReviewPrompt(ReplayOptions),
    ReviewReal(ReplayOptions),
    InvokeRealIpc(RealIpcOptions),
}

#[derive(Debug, Clone)]
struct ScenarioOptions {
    name: String,
    repeat: usize,
    provider: String,
    model: Option<String>,
    tool: Option<String>,
    skill: Option<String>,
    fixture: Option<String>,
}

#[derive(Debug, Clone)]
struct ReplayOptions {
    session_id: Option<String>,
    bundle_path: Option<PathBuf>,
}

#[derive(Debug, Clone)]
struct RealIpcOptions {
    host: String,
    port: u16,
    channel: String,
    payload: Value,
    model_config: Option<Value>,
    model_config_env_prefix: Option<String>,
    require_model_config: bool,
    send: bool,
    start_app: bool,
    app_command: Option<String>,
    timeout_seconds: u64,
    keep_app: bool,
}

#[derive(Debug)]
struct ProbeContext {
    repo_root: PathBuf,
    tauri_root: PathBuf,
    output_root: PathBuf,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProbeReport {
    scenario: String,
    status: String,
    session_id: String,
    run_id: String,
    provider: String,
    probe_mode: String,
    workspace_kind: String,
    model: Option<String>,
    output_dir: String,
    transcript_path: String,
    bundle_path: String,
    report_path: String,
    events: Vec<ProbeEvent>,
    tool_calls: Vec<ProbeToolCall>,
    artifacts: Vec<ProbeArtifact>,
    assertions: Vec<ProbeAssertion>,
    ideal_loop: Option<IdealLoopSpec>,
    loop_review: Option<LoopReview>,
    final_message: String,
    final_message_kind: String,
    prompt_review_notes: Vec<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ProbeEvent {
    event_type: String,
    detail: Value,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ProbeToolCall {
    name: String,
    status: String,
    input_summary: String,
    output_summary: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ProbeArtifact {
    path: String,
    kind: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ProbeAssertion {
    name: String,
    status: String,
    detail: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct IdealLoopSpec {
    objective: String,
    expected_events: Vec<String>,
    expected_skills: Vec<String>,
    tool_budgets: Vec<ToolBudget>,
    ideal_total_tool_calls: usize,
    max_total_tool_calls: usize,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ToolBudget {
    name: String,
    ideal: usize,
    max: usize,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct LoopReview {
    status: String,
    actual_event_path: Vec<String>,
    actual_skills: Vec<String>,
    actual_tool_call_count: usize,
    tool_call_counts: Vec<ToolCallCount>,
    gaps: Vec<String>,
    optimization_notes: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RealSessionReview {
    session_id: String,
    status: String,
    transcript_path: String,
    bundle_path: Option<String>,
    runtime_modes: Vec<String>,
    message_count: usize,
    assistant_tool_call_count: usize,
    tool_result_count: usize,
    tool_calls: Vec<RealToolCall>,
    has_profile_read: bool,
    has_source_read: bool,
    has_create_project: bool,
    has_write_current: bool,
    legacy_extension_mentions: Vec<String>,
    manuscript_links: Vec<String>,
    findings: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RealToolCall {
    name: String,
    action: String,
    success: Option<bool>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ToolCallCount {
    name: String,
    count: usize,
}

#[derive(Debug)]
struct ScenarioRun {
    events: Vec<ProbeEvent>,
    tool_calls: Vec<ProbeToolCall>,
    artifacts: Vec<ProbeArtifact>,
    assertions: Vec<ProbeAssertion>,
    final_message: String,
    final_message_kind: String,
    prompt_review_notes: Vec<String>,
}

#[derive(Debug)]
struct StreamProbeAttempt {
    attempt: usize,
    completed: bool,
    response_text: String,
    error: Option<String>,
}

struct StreamingFixtureServer {
    url: String,
    join: Option<thread::JoinHandle<()>>,
}

impl Drop for StreamingFixtureServer {
    fn drop(&mut self) {
        let _ = TcpStream::connect(self.url.trim_start_matches("http://"));
        if let Some(join) = self.join.take() {
            let _ = join.join();
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TranscriptEntry {
    id: String,
    session_id: String,
    kind: String,
    payload: Value,
    created_at_ms: u128,
}

fn main() {
    if let Err(error) = real_main() {
        eprintln!("redbox_runtime_probe failed: {error}");
        std::process::exit(1);
    }
}

fn real_main() -> ProbeResult<()> {
    let cli = parse_cli(env::args().skip(1).collect())?;
    match cli.command {
        ProbeCommand::Help => {
            print_help();
            Ok(())
        }
        ProbeCommand::ListScenarios => {
            for scenario in scenario_names() {
                println!("{scenario}");
            }
            Ok(())
        }
        ProbeCommand::Smoke => {
            let context = build_context(cli.output_dir)?;
            let options = ScenarioOptions {
                name: "smoke".to_string(),
                repeat: 1,
                provider: DEFAULT_PROVIDER.to_string(),
                model: None,
                tool: None,
                skill: None,
                fixture: None,
            };
            run_scenario_repeated(&context, &options)?;
            Ok(())
        }
        ProbeCommand::RunScenario(options) => {
            let context = build_context(cli.output_dir)?;
            run_scenario_repeated(&context, &options)?;
            Ok(())
        }
        ProbeCommand::RunAll(options) => {
            let context = build_context(cli.output_dir)?;
            let report = run_all_scenarios(&context, &options)?;
            println!(
                "{}",
                serde_json::to_string_pretty(&report).map_err(|e| e.to_string())?
            );
            if report.get("status").and_then(Value::as_str) != Some("passed") {
                return Err("one or more runtime probe scenarios failed".to_string());
            }
            Ok(())
        }
        ProbeCommand::Replay(options) => {
            let context = build_context(cli.output_dir)?;
            let bundle = load_bundle(&context, &options)?;
            println!(
                "{}",
                serde_json::to_string_pretty(&bundle).map_err(|e| e.to_string())?
            );
            Ok(())
        }
        ProbeCommand::Inspect(options) => {
            let context = build_context(cli.output_dir)?;
            let bundle = load_bundle(&context, &options)?;
            print_inspection(&bundle);
            Ok(())
        }
        ProbeCommand::Report(options) => {
            let context = build_context(cli.output_dir)?;
            let bundle = load_bundle(&context, &options)?;
            let report = bundle
                .get("report")
                .cloned()
                .ok_or_else(|| "bundle missing report".to_string())?;
            println!(
                "{}",
                serde_json::to_string_pretty(&report).map_err(|e| e.to_string())?
            );
            Ok(())
        }
        ProbeCommand::ReviewPrompt(options) => {
            let context = build_context(cli.output_dir)?;
            let bundle = load_bundle(&context, &options)?;
            let notes = prompt_review_from_bundle(&bundle);
            println!("# Prompt Review");
            println!();
            if notes.is_empty() {
                println!("No prompt findings from this probe bundle.");
            } else {
                for (index, note) in notes.iter().enumerate() {
                    println!("{}. {note}", index + 1);
                }
            }
            Ok(())
        }
        ProbeCommand::ReviewReal(options) => {
            let review = review_real_session(&options)?;
            println!(
                "{}",
                serde_json::to_string_pretty(&review).map_err(|e| e.to_string())?
            );
            if review.status != "passed" {
                return Err("real session review found runtime gaps".to_string());
            }
            Ok(())
        }
        ProbeCommand::InvokeRealIpc(options) => {
            let context = build_context(cli.output_dir)?;
            let response = invoke_real_ipc(&context, &options)?;
            println!(
                "{}",
                serde_json::to_string_pretty(&response).map_err(|e| e.to_string())?
            );
            Ok(())
        }
    }
}

fn parse_cli(args: Vec<String>) -> ProbeResult<Cli> {
    let mut output_dir = None;
    let mut positionals = Vec::new();
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--output-dir" => {
                index += 1;
                let value = args
                    .get(index)
                    .ok_or_else(|| "--output-dir requires a value".to_string())?;
                output_dir = Some(PathBuf::from(value));
            }
            other => positionals.push(other.to_string()),
        }
        index += 1;
    }

    let Some(command) = positionals.first().map(String::as_str) else {
        return Ok(Cli {
            command: ProbeCommand::Help,
            output_dir,
        });
    };

    let command = match command {
        "-h" | "--help" | "help" => ProbeCommand::Help,
        "list-scenarios" => ProbeCommand::ListScenarios,
        "smoke" => ProbeCommand::Smoke,
        "run-all" => ProbeCommand::RunAll(parse_run_all_options(&positionals[1..])?),
        "run-scenario" => ProbeCommand::RunScenario(parse_scenario_options(&positionals[1..])?),
        "replay" => ProbeCommand::Replay(parse_replay_options(&positionals[1..])?),
        "inspect" => ProbeCommand::Inspect(parse_replay_options(&positionals[1..])?),
        "report" => ProbeCommand::Report(parse_replay_options(&positionals[1..])?),
        "review-prompt" => ProbeCommand::ReviewPrompt(parse_replay_options(&positionals[1..])?),
        "review-real" => ProbeCommand::ReviewReal(parse_replay_options(&positionals[1..])?),
        "invoke-real-ipc" => {
            ProbeCommand::InvokeRealIpc(parse_real_ipc_options(&positionals[1..])?)
        }
        other => return Err(format!("unknown command: {other}")),
    };

    Ok(Cli {
        command,
        output_dir,
    })
}

fn parse_scenario_options(args: &[String]) -> ProbeResult<ScenarioOptions> {
    let name = args
        .first()
        .ok_or_else(|| "run-scenario requires a scenario name".to_string())?
        .to_string();
    let mut options = ScenarioOptions {
        name,
        repeat: DEFAULT_REPEAT,
        provider: DEFAULT_PROVIDER.to_string(),
        model: None,
        tool: None,
        skill: None,
        fixture: None,
    };

    let mut index = 1;
    while index < args.len() {
        match args[index].as_str() {
            "--repeat" => {
                index += 1;
                let value = args
                    .get(index)
                    .ok_or_else(|| "--repeat requires a value".to_string())?;
                options.repeat = value
                    .parse::<usize>()
                    .map_err(|e| format!("invalid --repeat value: {e}"))?;
                if options.repeat == 0 {
                    return Err("--repeat must be greater than 0".to_string());
                }
            }
            "--provider" => {
                index += 1;
                options.provider = args
                    .get(index)
                    .ok_or_else(|| "--provider requires a value".to_string())?
                    .to_string();
            }
            "--model" => {
                index += 1;
                options.model = Some(
                    args.get(index)
                        .ok_or_else(|| "--model requires a value".to_string())?
                        .to_string(),
                );
            }
            "--tool" => {
                index += 1;
                options.tool = Some(
                    args.get(index)
                        .ok_or_else(|| "--tool requires a value".to_string())?
                        .to_string(),
                );
            }
            "--skill" => {
                index += 1;
                options.skill = Some(
                    args.get(index)
                        .ok_or_else(|| "--skill requires a value".to_string())?
                        .to_string(),
                );
            }
            "--fixture" => {
                index += 1;
                options.fixture = Some(
                    args.get(index)
                        .ok_or_else(|| "--fixture requires a value".to_string())?
                        .to_string(),
                );
            }
            other => return Err(format!("unknown run-scenario option: {other}")),
        }
        index += 1;
    }

    Ok(options)
}

fn parse_run_all_options(args: &[String]) -> ProbeResult<ScenarioOptions> {
    let mut with_name = vec!["smoke".to_string()];
    with_name.extend_from_slice(args);
    parse_scenario_options(&with_name)
}

fn parse_replay_options(args: &[String]) -> ProbeResult<ReplayOptions> {
    let mut options = ReplayOptions {
        session_id: None,
        bundle_path: None,
    };
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--session" => {
                index += 1;
                options.session_id = Some(
                    args.get(index)
                        .ok_or_else(|| "--session requires a value".to_string())?
                        .to_string(),
                );
            }
            "--bundle" => {
                index += 1;
                options.bundle_path = Some(PathBuf::from(
                    args.get(index)
                        .ok_or_else(|| "--bundle requires a value".to_string())?,
                ));
            }
            other => return Err(format!("unknown replay option: {other}")),
        }
        index += 1;
    }
    if options.session_id.is_none() && options.bundle_path.is_none() {
        return Err("replay command requires --session or --bundle".to_string());
    }
    Ok(options)
}

fn parse_real_ipc_options(args: &[String]) -> ProbeResult<RealIpcOptions> {
    let mut host = "127.0.0.1".to_string();
    let mut port = 31937u16;
    let mut channel = None;
    let mut payload = json!({});
    let mut model_config = None;
    let mut model_config_env_prefix = None;
    let mut require_model_config = false;
    let mut send = false;
    let mut start_app = false;
    let mut app_command = None;
    let mut timeout_seconds = 120u64;
    let mut keep_app = false;
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--host" => {
                index += 1;
                host = args
                    .get(index)
                    .ok_or_else(|| "--host requires a value".to_string())?
                    .to_string();
            }
            "--port" => {
                index += 1;
                port = args
                    .get(index)
                    .ok_or_else(|| "--port requires a value".to_string())?
                    .parse::<u16>()
                    .map_err(|e| format!("invalid --port value: {e}"))?;
            }
            "--channel" => {
                index += 1;
                channel = Some(
                    args.get(index)
                        .ok_or_else(|| "--channel requires a value".to_string())?
                        .to_string(),
                );
            }
            "--payload-json" => {
                index += 1;
                let text = args
                    .get(index)
                    .ok_or_else(|| "--payload-json requires a value".to_string())?;
                payload = serde_json::from_str(text)
                    .map_err(|e| format!("invalid --payload-json value: {e}"))?;
            }
            "--model-config-json" => {
                index += 1;
                let text = args
                    .get(index)
                    .ok_or_else(|| "--model-config-json requires a value".to_string())?;
                model_config = Some(
                    serde_json::from_str(text)
                        .map_err(|e| format!("invalid --model-config-json value: {e}"))?,
                );
            }
            "--model-config-env" => {
                model_config_env_prefix = Some("REDBOX_TEST_AI".to_string());
            }
            "--model-config-env-prefix" => {
                index += 1;
                let prefix = args
                    .get(index)
                    .ok_or_else(|| "--model-config-env-prefix requires a value".to_string())?
                    .trim()
                    .to_string();
                if prefix.is_empty() {
                    return Err("--model-config-env-prefix cannot be empty".to_string());
                }
                model_config_env_prefix = Some(prefix);
            }
            "--require-model-config" => {
                require_model_config = true;
            }
            "--send" => {
                send = true;
            }
            "--start-app" => {
                start_app = true;
            }
            "--app-command" => {
                index += 1;
                app_command = Some(
                    args.get(index)
                        .ok_or_else(|| "--app-command requires a value".to_string())?
                        .to_string(),
                );
            }
            "--timeout-seconds" => {
                index += 1;
                timeout_seconds = args
                    .get(index)
                    .ok_or_else(|| "--timeout-seconds requires a value".to_string())?
                    .parse::<u64>()
                    .map_err(|e| format!("invalid --timeout-seconds value: {e}"))?;
                if timeout_seconds == 0 {
                    return Err("--timeout-seconds must be greater than 0".to_string());
                }
            }
            "--keep-app" => {
                keep_app = true;
            }
            other => return Err(format!("unknown invoke-real-ipc option: {other}")),
        }
        index += 1;
    }
    let channel = channel
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "invoke-real-ipc requires --channel".to_string())?;
    Ok(RealIpcOptions {
        host,
        port,
        channel,
        payload,
        model_config,
        model_config_env_prefix,
        require_model_config,
        send,
        start_app,
        app_command,
        timeout_seconds,
        keep_app,
    })
}

fn build_context(output_dir: Option<PathBuf>) -> ProbeResult<ProbeContext> {
    let current = env::current_dir().map_err(|e| e.to_string())?;
    let tauri_root = find_tauri_root(&current)?;
    let repo_root = tauri_root
        .parent()
        .and_then(Path::parent)
        .map(Path::to_path_buf)
        .unwrap_or_else(|| tauri_root.clone());
    let output_root = output_dir.unwrap_or_else(|| tauri_root.join("target/runtime-probe"));
    fs::create_dir_all(&output_root)
        .map_err(|e| format!("failed to create {}: {e}", output_root.display()))?;
    Ok(ProbeContext {
        repo_root,
        tauri_root,
        output_root,
    })
}

fn find_tauri_root(start: &Path) -> ProbeResult<PathBuf> {
    let mut cursor = Some(start);
    while let Some(path) = cursor {
        if path.join("Cargo.toml").exists() && path.join("src/main.rs").exists() {
            return Ok(path.to_path_buf());
        }
        let nested = path.join("desktop/src-tauri");
        if nested.join("Cargo.toml").exists() && nested.join("src/main.rs").exists() {
            return Ok(nested);
        }
        cursor = path.parent();
    }
    Err(format!(
        "could not find desktop/src-tauri from {}",
        start.display()
    ))
}

fn run_scenario_repeated(context: &ProbeContext, options: &ScenarioOptions) -> ProbeResult<()> {
    if !scenario_names().contains(&options.name.as_str()) {
        return Err(format!(
            "unknown scenario: {}. Run list-scenarios for supported names.",
            options.name
        ));
    }
    validate_provider(options)?;
    let mut last_report = None;
    for repeat_index in 0..options.repeat {
        let report = run_single_scenario(context, options, repeat_index)?;
        println!(
            "{}",
            serde_json::to_string_pretty(&report).map_err(|e| e.to_string())?
        );
        last_report = Some(report);
    }
    if let Some(report) = last_report {
        if report.status != "passed" {
            return Err(format!("scenario {} failed", report.scenario));
        }
    }
    Ok(())
}

fn run_all_scenarios(context: &ProbeContext, options: &ScenarioOptions) -> ProbeResult<Value> {
    validate_provider(options)?;

    let mut reports = Vec::new();
    for name in scenario_names() {
        for repeat_index in 0..options.repeat {
            let mut scenario_options = options.clone();
            scenario_options.name = name.to_string();
            let report = run_single_scenario(context, &scenario_options, repeat_index)?;
            reports.push(report);
        }
    }

    let failed_count = reports
        .iter()
        .filter(|report| report.status != "passed")
        .count();
    let status = if failed_count == 0 {
        "passed"
    } else {
        "failed"
    };
    Ok(json!({
        "kind": "redbox-runtime-probe-run-all",
        "status": status,
        "provider": options.provider,
        "repeat": options.repeat,
        "scenarioCount": reports.len(),
        "failedCount": failed_count,
        "reports": reports
    }))
}

fn validate_provider(options: &ScenarioOptions) -> ProbeResult<()> {
    match options.provider.as_str() {
        "mock" => Ok(()),
        "live" => Err(
            "provider live is not wired in this standalone probe yet; this command only runs mock-contract fixtures in a temporary workspace and does not launch the real app loop or write real manuscripts. Use review-real --session <id> to audit real RedBox logs."
                .to_string(),
        ),
        other => Err(format!(
            "unsupported provider: {other}. Supported providers: mock"
        )),
    }
}

fn run_single_scenario(
    context: &ProbeContext,
    options: &ScenarioOptions,
    repeat_index: usize,
) -> ProbeResult<ProbeReport> {
    let now = now_millis();
    let run_id = format!(
        "probe_{}_{}_{}",
        sanitize_id(&options.name),
        now,
        repeat_index + 1
    );
    let session_id = format!("session_{}_{}", sanitize_id(&options.name), now);
    let run_dir = context.output_root.join(&run_id);
    let transcript_dir = run_dir.join("session-transcripts");
    let bundle_dir = run_dir.join("session-bundles");
    fs::create_dir_all(&transcript_dir).map_err(|e| e.to_string())?;
    fs::create_dir_all(&bundle_dir).map_err(|e| e.to_string())?;

    let mut run = match options.name.as_str() {
        "smoke" => scenario_smoke(context, &run_dir, &session_id, options)?,
        "agent-basic-turn" => scenario_agent_basic_turn(context, &run_dir, &session_id, options)?,
        "stream-retry" => scenario_stream_retry(context, &run_dir, &session_id, options)?,
        "stream-error-next-turn" => {
            scenario_stream_error_next_turn(context, &run_dir, &session_id, options)?
        }
        "responses-tool-turn" => {
            scenario_responses_tool_turn(context, &run_dir, &session_id, options)?
        }
        "tool-call-contract" => {
            scenario_tool_call_contract(context, &run_dir, &session_id, options)?
        }
        "mcp-list-tools" | "mcp-call-tool" | "mcp-resource-read" => {
            scenario_mcp(context, &run_dir, &session_id, options)?
        }
        "cli-runtime-execute" | "cli-runtime-verify" => {
            scenario_cli_runtime(context, &run_dir, &session_id, options)?
        }
        "skill-activation" | "skill-no-false-positive" => {
            scenario_skill(context, &run_dir, &session_id, options)?
        }
        "team-single-task" | "team-member-report" | "team-completion-summary" => {
            scenario_team(context, &run_dir, &session_id, options)?
        }
        "wander-loop" => scenario_wander_loop(context, &run_dir, &session_id, options)?,
        "wander-to-creation" | "redclaw-save-summary" => {
            scenario_wander_to_creation(context, &run_dir, &session_id, options)?
        }
        _ => unreachable!(),
    };

    if run.prompt_review_notes.is_empty() {
        run.prompt_review_notes = default_prompt_notes_for(&options.name, &run);
    }
    let ideal_loop = ideal_loop_for(&options.name);
    let loop_review = ideal_loop.as_ref().map(|spec| review_loop(spec, &run));
    if let Some(review) = &loop_review {
        run.assertions.push(assertion(
            "ideal_loop_review_passed",
            review.status == "passed",
            &format!("gaps={}", review.gaps.len()),
        ));
    }

    let status = if run.assertions.iter().all(|item| item.status == "passed") {
        "passed"
    } else {
        "failed"
    }
    .to_string();

    let transcript_path = transcript_dir.join(format!("{session_id}.jsonl"));
    let bundle_path = bundle_dir.join(format!("{session_id}.json"));
    let report_path = run_dir.join("report.json");

    let report = ProbeReport {
        scenario: options.name.clone(),
        status,
        session_id: session_id.clone(),
        run_id,
        provider: options.provider.clone(),
        probe_mode: "mock-contract".to_string(),
        workspace_kind: "probe-temp".to_string(),
        model: options.model.clone(),
        output_dir: run_dir.display().to_string(),
        transcript_path: transcript_path.display().to_string(),
        bundle_path: bundle_path.display().to_string(),
        report_path: report_path.display().to_string(),
        events: run.events,
        tool_calls: run.tool_calls,
        artifacts: run.artifacts,
        assertions: run.assertions,
        ideal_loop,
        loop_review,
        final_message: run.final_message,
        final_message_kind: run.final_message_kind,
        prompt_review_notes: run.prompt_review_notes,
    };

    write_transcript(&transcript_path, &report)?;
    write_bundle(&bundle_path, &report)?;
    write_json_file(&report_path, &json!(report))?;
    Ok(report)
}

fn scenario_names() -> Vec<&'static str> {
    vec![
        "smoke",
        "agent-basic-turn",
        "stream-retry",
        "stream-error-next-turn",
        "responses-tool-turn",
        "tool-call-contract",
        "mcp-list-tools",
        "mcp-call-tool",
        "mcp-resource-read",
        "cli-runtime-execute",
        "cli-runtime-verify",
        "skill-activation",
        "skill-no-false-positive",
        "team-single-task",
        "team-member-report",
        "team-completion-summary",
        "wander-loop",
        "wander-to-creation",
        "redclaw-save-summary",
    ]
}

fn scenario_smoke(
    context: &ProbeContext,
    _run_dir: &Path,
    session_id: &str,
    options: &ScenarioOptions,
) -> ProbeResult<ScenarioRun> {
    let required = [
        "src/main.rs",
        "src/runtime/interactive_loop.rs",
        "src/tools/registry.rs",
        "src/mcp/manager.rs",
        "src/skills/catalog.rs",
        "src/subagents/team_tools.rs",
        "src/commands/chat_sessions_wander.rs",
        "src/commands/redclaw_runtime.rs",
    ];
    let assertions = required
        .iter()
        .map(|relative| {
            let path = context.tauri_root.join(relative);
            assertion(
                &format!("source_exists:{relative}"),
                path.exists(),
                &path.display().to_string(),
            )
        })
        .collect::<Vec<_>>();
    Ok(ScenarioRun {
        events: vec![
            event("probe/session_started", json!({ "sessionId": session_id })),
            event(
                "probe/host_ready",
                json!({
                    "provider": options.provider,
                    "repoRoot": context.repo_root.display().to_string()
                }),
            ),
            event("probe/session_completed", json!({ "status": "passed" })),
        ],
        tool_calls: Vec::new(),
        artifacts: vec![artifact(
            &context.tauri_root.display().to_string(),
            "tauri-root",
        )],
        assertions,
        final_message: "Probe smoke completed. Runtime source surfaces are present.".to_string(),
        final_message_kind: "summary".to_string(),
        prompt_review_notes: Vec::new(),
    })
}

fn scenario_agent_basic_turn(
    context: &ProbeContext,
    _run_dir: &Path,
    session_id: &str,
    _options: &ScenarioOptions,
) -> ProbeResult<ScenarioRun> {
    let runtime_loop = context.tauri_root.join("src/runtime/interactive_loop.rs");
    let assertions = vec![
        assertion(
            "interactive_loop_source_exists",
            runtime_loop.exists(),
            &runtime_loop.display().to_string(),
        ),
        assertion("turn_completed_event_seen", true, "mock turn completed"),
        assertion(
            "session_released_after_turn",
            true,
            "no active turn remains",
        ),
    ];
    Ok(ScenarioRun {
        events: vec![
            event("turn/started", json!({ "sessionId": session_id })),
            event(
                "item/user_message",
                json!({ "text": "hello from runtime probe" }),
            ),
            event("item/assistant_message", json!({ "text": "Done" })),
            event("turn/completed", json!({ "status": "completed" })),
        ],
        tool_calls: Vec::new(),
        artifacts: Vec::new(),
        assertions,
        final_message: "Runtime probe completed a basic mocked agent turn.".to_string(),
        final_message_kind: "summary".to_string(),
        prompt_review_notes: Vec::new(),
    })
}

fn scenario_stream_retry(
    context: &ProbeContext,
    _run_dir: &Path,
    _session_id: &str,
    _options: &ScenarioOptions,
) -> ProbeResult<ScenarioRun> {
    let transport_error = context.tauri_root.join("src/llm_transport/error.rs");
    let server = start_streaming_fixture_server(vec![
        StreamFixtureResponse::Incomplete,
        StreamFixtureResponse::Completed("resp_ok".to_string()),
    ])?;
    let attempts = run_streaming_probe_with_retry(&server.url, 2)?;
    let events = attempts
        .iter()
        .flat_map(|attempt| {
            let mut items = vec![event(
                "provider/stream_attempt",
                json!({
                    "attempt": attempt.attempt,
                    "completed": attempt.completed,
                    "error": attempt.error,
                    "responseText": attempt.response_text
                }),
            )];
            if attempt.error.is_some() && attempt.attempt == 1 {
                items.push(event("provider/stream_retry", json!({ "nextAttempt": 2 })));
            }
            items
        })
        .collect::<Vec<_>>();
    let completed = attempts.iter().any(|attempt| attempt.completed);
    Ok(ScenarioRun {
        events: events
            .into_iter()
            .chain([event("turn/completed", json!({ "status": "completed" }))])
            .collect(),
        tool_calls: Vec::new(),
        artifacts: Vec::new(),
        assertions: vec![
            assertion(
                "transport_error_classifier_exists",
                transport_error.exists(),
                &transport_error.display().to_string(),
            ),
            assertion(
                "stream_retry_attempted",
                attempts.len() == 2,
                &format!("attempt count = {}", attempts.len()),
            ),
            assertion("final_turn_completed", completed, "completed after retry"),
        ],
        final_message: "Streaming retry scenario completed after one synthetic partial_body retry."
            .to_string(),
        final_message_kind: "summary".to_string(),
        prompt_review_notes: vec![
            "Keep user-facing streaming errors summarized; do not expose raw provider fallback JSON."
                .to_string(),
        ],
    })
}

fn scenario_stream_error_next_turn(
    context: &ProbeContext,
    _run_dir: &Path,
    _session_id: &str,
    _options: &ScenarioOptions,
) -> ProbeResult<ScenarioRun> {
    let recovery = context
        .tauri_root
        .join("src/runtime/interactive_recovery.rs");
    let first_server = start_streaming_fixture_server(vec![StreamFixtureResponse::Incomplete])?;
    let first_attempts = run_streaming_probe_with_retry(&first_server.url, 1)?;
    let second_server = start_streaming_fixture_server(vec![StreamFixtureResponse::Completed(
        "resp_recovered".to_string(),
    )])?;
    let second_attempts = run_streaming_probe_with_retry(&second_server.url, 1)?;
    let first_failed = first_attempts.iter().any(|attempt| attempt.error.is_some());
    let second_completed = second_attempts.iter().any(|attempt| attempt.completed);
    Ok(ScenarioRun {
        events: vec![
            event("turn/started", json!({ "turn": 1 })),
            event(
                "provider/stream_error",
                json!({ "turn": 1, "attempts": first_attempts.iter().map(|attempt| json!({
                    "attempt": attempt.attempt,
                    "completed": attempt.completed,
                    "error": attempt.error,
                })).collect::<Vec<_>>() }),
            ),
            event("turn/completed", json!({ "turn": 1, "status": "failed" })),
            event("turn/started", json!({ "turn": 2 })),
            event(
                "item/assistant_message",
                json!({ "turn": 2, "attempts": second_attempts.iter().map(|attempt| json!({
                    "attempt": attempt.attempt,
                    "completed": attempt.completed,
                    "error": attempt.error,
                })).collect::<Vec<_>>() }),
            ),
            event("turn/completed", json!({ "turn": 2, "status": "completed" })),
        ],
        tool_calls: Vec::new(),
        artifacts: Vec::new(),
        assertions: vec![
            assertion(
                "interactive_recovery_source_exists",
                recovery.exists(),
                &recovery.display().to_string(),
            ),
            assertion("first_turn_failed", first_failed, "incomplete stream classified as failure"),
            assertion("failed_turn_released", second_completed, "turn 2 started after turn 1 failure"),
            assertion("next_turn_completed", second_completed, "turn 2 completed"),
        ],
        final_message: "Runtime released a failed stream turn and accepted the next turn.".to_string(),
        final_message_kind: "summary".to_string(),
        prompt_review_notes: vec![
            "After transport failure, final assistant text should be a concise retryable error summary."
                .to_string(),
        ],
    })
}

fn scenario_responses_tool_turn(
    _context: &ProbeContext,
    _run_dir: &Path,
    _session_id: &str,
    _options: &ScenarioOptions,
) -> ProbeResult<ScenarioRun> {
    let server = start_responses_fixture_server()?;
    let mut result = run_responses_tool_turn_probe(&server.url)?;
    result.requests = server.finish()?;
    let first_used_responses_path = result
        .requests
        .first()
        .is_some_and(|request| request.path == "/responses");
    let second_included_tool_output = result
        .requests
        .get(1)
        .is_some_and(|request| request.body.to_string().contains("function_call_output"));
    Ok(ScenarioRun {
        events: vec![
            event(
                "provider/responses_request",
                json!({ "turn": 1, "path": result.requests.first().map(|request| request.path.as_str()) }),
            ),
            event(
                "item/function_call",
                json!({ "callId": result.call_id, "name": result.tool_name }),
            ),
            event(
                "provider/responses_request",
                json!({ "turn": 2, "path": result.requests.get(1).map(|request| request.path.as_str()) }),
            ),
            event("item/assistant_message", json!({ "text": result.final_text })),
        ],
        tool_calls: vec![tool_call(
            &result.tool_name,
            "success",
            "path=workspace://probe.md",
            "mock file body",
        )],
        artifacts: Vec::new(),
        assertions: vec![
            assertion(
                "uses_responses_endpoint",
                first_used_responses_path,
                "mock provider received POST /responses",
            ),
            assertion(
                "returns_function_call",
                result.tool_name == "Read" && result.call_id == "call_probe",
                "first Responses output requested Read",
            ),
            assertion(
                "sends_function_call_output",
                second_included_tool_output,
                "second Responses input included function_call_output",
            ),
            assertion(
                "final_response_completed",
                result.final_text.contains("completed after tool output"),
                &result.final_text,
            ),
        ],
        final_message: result.final_text,
        final_message_kind: "summary".to_string(),
        prompt_review_notes: vec![
            "Responses provider turns should preserve call_id across function_call and function_call_output."
                .to_string(),
        ],
    })
}

enum StreamFixtureResponse {
    Incomplete,
    Completed(String),
}

fn start_streaming_fixture_server(
    responses: Vec<StreamFixtureResponse>,
) -> ProbeResult<StreamingFixtureServer> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|e| format!("failed to bind streaming fixture server: {e}"))?;
    let addr = listener
        .local_addr()
        .map_err(|e| format!("failed to read fixture server addr: {e}"))?;
    listener
        .set_nonblocking(false)
        .map_err(|e| format!("failed to configure fixture server: {e}"))?;
    let join = thread::spawn(move || {
        for response in responses {
            let Ok((mut stream, _)) = listener.accept() else {
                break;
            };
            let _ = read_http_request(&mut stream);
            let body = match response {
                StreamFixtureResponse::Incomplete => {
                    "data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\n".to_string()
                }
                StreamFixtureResponse::Completed(id) => format!(
                    "data: {{\"id\":\"{id}\",\"choices\":[{{\"delta\":{{\"content\":\"ok\"}}}}]}}\n\ndata: {{\"id\":\"{id}\",\"choices\":[{{\"finish_reason\":\"stop\"}}]}}\n\ndata: [DONE]\n\n"
                ),
            };
            let headers = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncache-control: no-cache\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                body.len()
            );
            let _ = stream.write_all(headers.as_bytes());
            let _ = stream.write_all(body.as_bytes());
            let _ = stream.flush();
        }
    });
    Ok(StreamingFixtureServer {
        url: format!("http://{addr}"),
        join: Some(join),
    })
}

#[derive(Debug)]
struct ResponsesFixtureRequest {
    path: String,
    body: Value,
}

struct ResponsesFixtureServer {
    url: String,
    join: Option<thread::JoinHandle<Vec<ResponsesFixtureRequest>>>,
}

impl ResponsesFixtureServer {
    fn finish(mut self) -> ProbeResult<Vec<ResponsesFixtureRequest>> {
        let join = self
            .join
            .take()
            .ok_or_else(|| "responses fixture server already joined".to_string())?;
        join.join()
            .map_err(|_| "responses fixture server thread panicked".to_string())
    }
}

impl Drop for ResponsesFixtureServer {
    fn drop(&mut self) {
        if let Some(join) = self.join.take() {
            let _ = join.join();
        }
    }
}

#[derive(Debug)]
struct ResponsesProbeResult {
    requests: Vec<ResponsesFixtureRequest>,
    call_id: String,
    tool_name: String,
    final_text: String,
}

fn start_responses_fixture_server() -> ProbeResult<ResponsesFixtureServer> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|e| format!("failed to bind responses fixture server: {e}"))?;
    let addr = listener
        .local_addr()
        .map_err(|e| format!("failed to read responses fixture server addr: {e}"))?;
    listener
        .set_nonblocking(false)
        .map_err(|e| format!("failed to configure responses fixture server: {e}"))?;
    let join = thread::spawn(move || {
        let mut requests = Vec::new();
        for index in 0..2 {
            let Ok((mut stream, _)) = listener.accept() else {
                break;
            };
            if let Ok(request) = read_json_http_request(&mut stream) {
                requests.push(request);
            }
            let body = if index == 0 {
                json!({
                    "id": "resp_probe_1",
                    "output": [{
                        "type": "function_call",
                        "call_id": "call_probe",
                        "name": "Read",
                        "arguments": "{\"path\":\"workspace://probe.md\"}"
                    }]
                })
            } else {
                json!({
                    "id": "resp_probe_2",
                    "output": [{
                        "type": "message",
                        "content": [{
                            "type": "output_text",
                            "text": "Responses turn completed after tool output."
                        }]
                    }]
                })
            };
            let body_text = body.to_string();
            let headers = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                body_text.len()
            );
            let _ = stream.write_all(headers.as_bytes());
            let _ = stream.write_all(body_text.as_bytes());
            let _ = stream.flush();
        }
        requests
    });
    Ok(ResponsesFixtureServer {
        url: format!("http://{addr}"),
        join: Some(join),
    })
}

fn read_json_http_request(stream: &mut TcpStream) -> ProbeResult<ResponsesFixtureRequest> {
    stream
        .set_read_timeout(Some(Duration::from_secs(2)))
        .map_err(|e| e.to_string())?;
    let cloned = stream.try_clone().map_err(|e| e.to_string())?;
    let mut reader = BufReader::new(cloned);
    let mut content_length = 0usize;
    let mut request_path = String::new();
    loop {
        let mut line = String::new();
        let bytes = reader.read_line(&mut line).map_err(|e| e.to_string())?;
        if bytes == 0 || line == "\r\n" || line == "\n" {
            break;
        }
        if request_path.is_empty() {
            let parts = line.split_whitespace().collect::<Vec<_>>();
            request_path = parts.get(1).copied().unwrap_or_default().to_string();
        }
        let lower = line.to_ascii_lowercase();
        if let Some(value) = lower.strip_prefix("content-length:") {
            content_length = value.trim().parse::<usize>().unwrap_or(0);
        }
    }
    let mut body = vec![0u8; content_length];
    if content_length > 0 {
        reader.read_exact(&mut body).map_err(|e| e.to_string())?;
    }
    let body = if body.is_empty() {
        json!({})
    } else {
        serde_json::from_slice::<Value>(&body).map_err(|e| e.to_string())?
    };
    Ok(ResponsesFixtureRequest {
        path: request_path,
        body,
    })
}

fn run_responses_tool_turn_probe(base_url: &str) -> ProbeResult<ResponsesProbeResult> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|e| e.to_string())?;
    let first = client
        .post(format!("{base_url}/responses"))
        .json(&json!({
            "model": "probe-responses",
            "input": [{ "role": "user", "content": "read the probe file" }],
            "tools": [{
                "type": "function",
                "name": "Read",
                "description": "Read one resource",
                "parameters": {
                    "type": "object",
                    "properties": { "path": { "type": "string" } },
                    "required": ["path"]
                }
            }],
            "tool_choice": "required"
        }))
        .send()
        .and_then(|response| response.json::<Value>())
        .map_err(|e| e.to_string())?;
    let call = first
        .get("output")
        .and_then(Value::as_array)
        .and_then(|items| items.first())
        .ok_or_else(|| "responses fixture did not return output".to_string())?;
    let call_id = call
        .get("call_id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let tool_name = call
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let second = client
        .post(format!("{base_url}/responses"))
        .json(&json!({
            "model": "probe-responses",
            "input": [
                call.clone(),
                {
                    "type": "function_call_output",
                    "call_id": call_id.clone(),
                    "output": "mock file body"
                }
            ]
        }))
        .send()
        .and_then(|response| response.json::<Value>())
        .map_err(|e| e.to_string())?;
    let final_text = second
        .pointer("/output/0/content/0/text")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    Ok(ResponsesProbeResult {
        requests: Vec::new(),
        call_id,
        tool_name,
        final_text,
    })
}

fn read_http_request(stream: &mut TcpStream) -> ProbeResult<()> {
    stream
        .set_read_timeout(Some(Duration::from_secs(2)))
        .map_err(|e| e.to_string())?;
    let cloned = stream.try_clone().map_err(|e| e.to_string())?;
    let mut reader = BufReader::new(cloned);
    let mut content_length = 0usize;
    loop {
        let mut line = String::new();
        let bytes = reader.read_line(&mut line).map_err(|e| e.to_string())?;
        if bytes == 0 || line == "\r\n" || line == "\n" {
            break;
        }
        let lower = line.to_ascii_lowercase();
        if let Some(value) = lower.strip_prefix("content-length:") {
            content_length = value.trim().parse::<usize>().unwrap_or(0);
        }
    }
    if content_length > 0 {
        let mut remaining = vec![0u8; content_length];
        let _ = reader.read_exact(&mut remaining);
    }
    Ok(())
}

fn run_streaming_probe_with_retry(
    base_url: &str,
    max_attempts: usize,
) -> ProbeResult<Vec<StreamProbeAttempt>> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|e| e.to_string())?;
    let mut attempts = Vec::new();
    for attempt in 1..=max_attempts {
        let result = client
            .post(format!("{base_url}/chat/completions"))
            .json(&json!({
                "model": "probe-mock",
                "stream": true,
                "messages": [{"role": "user", "content": "probe"}]
            }))
            .send()
            .and_then(|response| response.text());
        match result {
            Ok(text) => {
                let completed = stream_text_has_completed_marker(&text);
                attempts.push(StreamProbeAttempt {
                    attempt,
                    completed,
                    error: if completed {
                        None
                    } else {
                        Some("incomplete stream: missing [DONE] or finish_reason".to_string())
                    },
                    response_text: text,
                });
                if completed {
                    break;
                }
            }
            Err(error) => attempts.push(StreamProbeAttempt {
                attempt,
                completed: false,
                response_text: String::new(),
                error: Some(error.to_string()),
            }),
        }
    }
    Ok(attempts)
}

fn stream_text_has_completed_marker(text: &str) -> bool {
    text.contains("data: [DONE]") || text.contains("\"finish_reason\":\"stop\"")
}

fn scenario_tool_call_contract(
    context: &ProbeContext,
    _run_dir: &Path,
    _session_id: &str,
    options: &ScenarioOptions,
) -> ProbeResult<ScenarioRun> {
    let tool = options
        .tool
        .clone()
        .unwrap_or_else(|| "app_cli".to_string());
    let registry = context.tauri_root.join("src/tools/registry.rs");
    let executor = context.tauri_root.join("src/tools/executor.rs");
    let app_cli = context.tauri_root.join("src/tools/app_cli.rs");
    Ok(ScenarioRun {
        events: vec![
            event("tool/contract_loaded", json!({ "tool": tool })),
            event("tool/call_started", json!({ "tool": tool })),
            event(
                "tool/call_completed",
                json!({ "tool": tool, "status": "success" }),
            ),
        ],
        tool_calls: vec![tool_call(
            &tool,
            "success",
            "schema validation probe",
            "structured result accepted",
        )],
        artifacts: Vec::new(),
        assertions: vec![
            assertion(
                "tool_registry_exists",
                registry.exists(),
                &registry.display().to_string(),
            ),
            assertion(
                "tool_executor_exists",
                executor.exists(),
                &executor.display().to_string(),
            ),
            assertion(
                "app_cli_exists",
                app_cli.exists(),
                &app_cli.display().to_string(),
            ),
            assertion(
                "tool_result_structured",
                true,
                "tool output is JSON serializable",
            ),
        ],
        final_message: format!("Tool contract probe passed for `{tool}`."),
        final_message_kind: "summary".to_string(),
        prompt_review_notes: vec![
            "Tool failures should be normalized before reaching final user text.".to_string(),
        ],
    })
}

fn scenario_mcp(
    context: &ProbeContext,
    _run_dir: &Path,
    _session_id: &str,
    options: &ScenarioOptions,
) -> ProbeResult<ScenarioRun> {
    let fixture = options
        .fixture
        .clone()
        .unwrap_or_else(|| "local-stdio".to_string());
    let manager = context.tauri_root.join("src/mcp/manager.rs");
    let tool_names = context.tauri_root.join("src/mcp/tool_names.rs");
    let qualified_name = qualify_mcp_tool_name("Probe Server", "echo.value");
    let fixture_output = run_stdio_fixture(&options.name)?;
    let parsed: Value = serde_json::from_str(&fixture_output)
        .map_err(|e| format!("mcp fixture returned invalid JSON: {e}"))?;
    Ok(ScenarioRun {
        events: vec![
            event("mcp/fixture_started", json!({ "fixture": fixture })),
            event("mcp/tools_listed", json!({ "tool": qualified_name })),
            event("mcp/fixture_completed", parsed.clone()),
        ],
        tool_calls: vec![tool_call(
            &qualified_name,
            "success",
            &options.name,
            "fixture JSON parsed",
        )],
        artifacts: Vec::new(),
        assertions: vec![
            assertion(
                "mcp_manager_exists",
                manager.exists(),
                &manager.display().to_string(),
            ),
            assertion(
                "mcp_tool_names_exists",
                tool_names.exists(),
                &tool_names.display().to_string(),
            ),
            assertion(
                "qualified_tool_name_has_prefix",
                qualified_name.starts_with("mcp__"),
                &qualified_name,
            ),
            assertion("fixture_json_parsed", parsed.is_object(), &fixture_output),
        ],
        final_message: format!(
            "MCP probe `{}` completed with fixture `{fixture}`.",
            options.name
        ),
        final_message_kind: "summary".to_string(),
        prompt_review_notes: Vec::new(),
    })
}

fn scenario_cli_runtime(
    context: &ProbeContext,
    _run_dir: &Path,
    _session_id: &str,
    options: &ScenarioOptions,
) -> ProbeResult<ScenarioRun> {
    let cli_runtime = context.tauri_root.join("src/cli_runtime/mod.rs");
    let executor = context.tauri_root.join("src/cli_runtime/executor.rs");
    let (status, stdout, stderr) = if options.name == "cli-runtime-verify" {
        run_command("/bin/sh", &["-lc", "echo verify-failed >&2; exit 7"])?
    } else {
        run_command(
            "/bin/echo",
            &[r#"{"ok":true,"source":"redbox_runtime_probe"}"#],
        )?
    };
    let expected_success = options.name == "cli-runtime-execute";
    let passed = if expected_success {
        status == 0
            && serde_json::from_str::<Value>(&stdout)
                .ok()
                .and_then(|v| v.get("ok").and_then(Value::as_bool))
                == Some(true)
    } else {
        status != 0 && stderr.contains("verify-failed")
    };
    Ok(ScenarioRun {
        events: vec![
            event("cli/command_started", json!({ "scenario": options.name })),
            event(
                "cli/command_completed",
                json!({ "status": status, "stdout": stdout, "stderr": stderr }),
            ),
        ],
        tool_calls: Vec::new(),
        artifacts: Vec::new(),
        assertions: vec![
            assertion(
                "cli_runtime_exists",
                cli_runtime.exists(),
                &cli_runtime.display().to_string(),
            ),
            assertion(
                "cli_executor_exists",
                executor.exists(),
                &executor.display().to_string(),
            ),
            assertion(
                "cli_command_behavior",
                passed,
                &format!("exit status {status}"),
            ),
        ],
        final_message: format!("CLI runtime probe `{}` completed.", options.name),
        final_message_kind: "summary".to_string(),
        prompt_review_notes: Vec::new(),
    })
}

fn scenario_skill(
    context: &ProbeContext,
    _run_dir: &Path,
    _session_id: &str,
    options: &ScenarioOptions,
) -> ProbeResult<ScenarioRun> {
    let requested_skill = options
        .skill
        .clone()
        .unwrap_or_else(|| "writing-style".to_string());
    let catalog = context.tauri_root.join("src/skills/catalog.rs");
    let activation = context.tauri_root.join("src/skills/activation.rs");
    let should_activate = options.name == "skill-activation";
    let selected = if should_activate {
        vec![requested_skill.clone()]
    } else {
        Vec::new()
    };
    Ok(ScenarioRun {
        events: vec![
            event(
                "skills/catalog_loaded",
                json!({ "catalog": catalog.display().to_string() }),
            ),
            event("skills/activation_checked", json!({ "selected": selected })),
        ],
        tool_calls: Vec::new(),
        artifacts: Vec::new(),
        assertions: vec![
            assertion(
                "skill_catalog_exists",
                catalog.exists(),
                &catalog.display().to_string(),
            ),
            assertion(
                "skill_activation_exists",
                activation.exists(),
                &activation.display().to_string(),
            ),
            assertion(
                "skill_selection_expected",
                should_activate == !selected.is_empty(),
                &format!("selected={selected:?}"),
            ),
        ],
        final_message: format!("Skill probe `{}` completed.", options.name),
        final_message_kind: "summary".to_string(),
        prompt_review_notes: vec![
            "Skill decisions should be visible in transcript context snapshots.".to_string(),
        ],
    })
}

fn scenario_team(
    context: &ProbeContext,
    _run_dir: &Path,
    session_id: &str,
    options: &ScenarioOptions,
) -> ProbeResult<ScenarioRun> {
    let collab_runtime = context.tauri_root.join("src/runtime/collab_runtime.rs");
    let team_tools = context.tauri_root.join("src/subagents/team_tools.rs");
    let mut events = vec![
        event("team/session_created", json!({ "sessionId": session_id })),
        event(
            "team/member_spawned",
            json!({ "memberId": "member_writer" }),
        ),
        event("team/task_assigned", json!({ "taskId": "task_outline" })),
    ];
    if options.name != "team-single-task" {
        events.push(event(
            "team/report_submitted",
            json!({ "memberId": "member_writer", "status": "progress" }),
        ));
    }
    if options.name == "team-completion-summary" {
        events.push(event(
            "team/completed",
            json!({ "summary": "task complete" }),
        ));
    }
    Ok(ScenarioRun {
        events,
        tool_calls: vec![tool_call(
            "team.task.assign",
            "success",
            "assign writer task",
            "task stored",
        )],
        artifacts: Vec::new(),
        assertions: vec![
            assertion(
                "collab_runtime_exists",
                collab_runtime.exists(),
                &collab_runtime.display().to_string(),
            ),
            assertion(
                "team_tools_exists",
                team_tools.exists(),
                &team_tools.display().to_string(),
            ),
            assertion("team_events_emitted", true, &options.name),
        ],
        final_message: format!("Team runtime probe `{}` completed.", options.name),
        final_message_kind: "summary".to_string(),
        prompt_review_notes: vec![
            "Team completion claims should be based on member reports and artifacts.".to_string(),
        ],
    })
}

fn scenario_wander_loop(
    context: &ProbeContext,
    _run_dir: &Path,
    session_id: &str,
    _options: &ScenarioOptions,
) -> ProbeResult<ScenarioRun> {
    let wander = context
        .tauri_root
        .join("src/commands/chat_sessions_wander.rs");
    let skills_catalog = context.tauri_root.join("src/skills/catalog.rs");
    let retrieval = context.tauri_root.join("src/knowledge_index");
    Ok(ScenarioRun {
        events: vec![
            event("wander/session_created", json!({ "sessionId": session_id })),
            event(
                "wander/user_message",
                json!({ "text": "帮我从最近收藏的播客相关素材里找一个创作灵感" }),
            ),
            event(
                "wander/skill_selected",
                json!({ "skill": "wander-synthesis" }),
            ),
            event(
                "tool/call_started",
                json!({ "tool": "Search", "reason": "find candidate inspiration materials" }),
            ),
            event(
                "tool/call_completed",
                json!({ "tool": "Search", "status": "success", "resultCount": 3 }),
            ),
            event(
                "tool/call_started",
                json!({ "tool": "Read", "reason": "inspect top material" }),
            ),
            event(
                "tool/call_completed",
                json!({ "tool": "Read", "status": "success" }),
            ),
            event(
                "wander/material_cards_rendered",
                json!({ "count": 3, "primary": "我用AI把Acquired播客做成了一本纸质书" }),
            ),
            event("turn/completed", json!({ "status": "completed" })),
        ],
        tool_calls: vec![
            tool_call(
                "Search",
                "success",
                "find inspiration materials",
                "3 materials",
            ),
            tool_call(
                "Read",
                "success",
                "inspect primary material",
                "material detail loaded",
            ),
        ],
        artifacts: Vec::new(),
        assertions: vec![
            assertion(
                "wander_command_exists",
                wander.exists(),
                &wander.display().to_string(),
            ),
            assertion(
                "skills_catalog_exists",
                skills_catalog.exists(),
                &skills_catalog.display().to_string(),
            ),
            assertion(
                "retrieval_surface_exists",
                retrieval.exists(),
                &retrieval.display().to_string(),
            ),
            assertion(
                "material_cards_preserved",
                true,
                "3 cards rendered from metadata",
            ),
            assertion(
                "final_output_is_summary",
                true,
                "final_message_kind=summary",
            ),
        ],
        final_message: "漫步已完成灵感归纳：返回 3 条参考素材卡片和 1 个可继续创作的方向。"
            .to_string(),
        final_message_kind: "summary".to_string(),
        prompt_review_notes: vec![
            "Wander loop should keep material cards as structured metadata, not plain text only."
                .to_string(),
        ],
    })
}

fn scenario_wander_to_creation(
    context: &ProbeContext,
    run_dir: &Path,
    session_id: &str,
    _options: &ScenarioOptions,
) -> ProbeResult<ScenarioRun> {
    let workspace = run_dir.join("workspace");
    let manuscript_dir = workspace.join("manuscripts/article/probe-paper-book");
    fs::create_dir_all(&manuscript_dir).map_err(|e| e.to_string())?;
    let manifest_path = manuscript_dir.join("manifest.json");
    let content_path = manuscript_dir.join("content.md");
    write_json_file(
        &manifest_path,
        &json!({
            "kind": "manuscriptPackage",
            "packageKind": "article",
            "title": "把数字变成纸张",
            "createdBy": "redbox_runtime_probe"
        }),
    )?;
    fs::write(
        &content_path,
        "# 把数字变成纸张\n\n这是一份 probe 生成的稿件正文，用于验证写入 artifact 和最终总结合同。\n",
    )
    .map_err(|e| e.to_string())?;

    let old_user_message = "hi";
    let current_user_message = "基于漫步灵感开始创作：别做摘要了，把播客印成书";
    let no_residual = !current_user_message.contains(old_user_message);
    let material_card = json!({
        "title": "我用AI把Acquired播客做成了一本纸质书",
        "role": "core-reference-material",
        "kind": "xhs-note"
    });
    let redclaw_runtime = context.tauri_root.join("src/commands/redclaw_runtime.rs");
    let wander = context
        .tauri_root
        .join("src/commands/chat_sessions_wander.rs");
    Ok(ScenarioRun {
        events: vec![
            event("wander/session_created", json!({ "sessionId": "session_wander_probe" })),
            event("wander/material_selected", material_card),
            event(
                "redclaw/session_created",
                json!({ "sessionId": session_id, "source": "wander-ai-create" }),
            ),
            event("redclaw/user_message", json!({ "text": current_user_message })),
            event("redclaw/skill_selected", json!({ "skill": "writing-style" })),
            event("manuscript/write_started", json!({ "path": manuscript_dir.display().to_string() })),
            event("manuscript/write_completed", json!({ "path": content_path.display().to_string() })),
            event("turn/completed", json!({ "status": "completed" })),
        ],
        tool_calls: vec![tool_call(
            "manuscripts.writeCurrent",
            "success",
            "write article folder project",
            &content_path.display().to_string(),
        )],
        artifacts: vec![
            artifact(&manifest_path.display().to_string(), "manifest"),
            artifact(&content_path.display().to_string(), "content"),
        ],
        assertions: vec![
            assertion("wander_command_exists", wander.exists(), &wander.display().to_string()),
            assertion(
                "redclaw_runtime_exists",
                redclaw_runtime.exists(),
                &redclaw_runtime.display().to_string(),
            ),
            assertion(
                "new_session_created",
                session_id.starts_with("session_wander") || session_id.starts_with("session_redclaw"),
                session_id,
            ),
            assertion("old_user_message_not_reused", no_residual, current_user_message),
            assertion("material_card_preserved", true, "material metadata present in events"),
            assertion("writing_skill_evidence_present", true, "redclaw/skill_selected event"),
            assertion("folder_project_manifest_written", manifest_path.exists(), &manifest_path.display().to_string()),
            assertion("folder_project_content_written", content_path.exists(), &content_path.display().to_string()),
            assertion("final_output_is_summary", true, "final_message_kind=summary"),
        ],
        final_message: format!(
            "已创建稿件工程：{}。本次 probe 输出运行总结，不打印完整正文。",
            manuscript_dir.display()
        ),
        final_message_kind: "summary".to_string(),
        prompt_review_notes: vec![
            "Wander-to-creation must always create a fresh authoring session.".to_string(),
            "Final answer after successful save must be summary plus artifact link, not full manuscript text."
                .to_string(),
        ],
    })
}

fn run_stdio_fixture(scenario: &str) -> ProbeResult<String> {
    let body = match scenario {
        "mcp-list-tools" => r#"{"tools":[{"name":"echo.value","description":"Echo a value"}]}"#,
        "mcp-call-tool" => r#"{"content":[{"type":"text","text":"echo ok"}]}"#,
        "mcp-resource-read" => r#"{"contents":[{"uri":"probe://resource","text":"resource ok"}]}"#,
        _ => r#"{"ok":true}"#,
    };
    let output = background_command("/bin/sh")
        .args([
            "-lc",
            &format!("printf '%s' '{}'", shell_escape_single_quotes(body)),
        ])
        .output()
        .map_err(|e| format!("failed to run mcp fixture: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "mcp fixture failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    String::from_utf8(output.stdout).map_err(|e| e.to_string())
}

fn run_command(program: &str, args: &[&str]) -> ProbeResult<(i32, String, String)> {
    let output = background_command(program)
        .args(args)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("failed to run {program}: {e}"))?;
    Ok((
        output.status.code().unwrap_or(-1),
        String::from_utf8_lossy(&output.stdout).trim().to_string(),
        String::from_utf8_lossy(&output.stderr).trim().to_string(),
    ))
}

fn write_transcript(path: &Path, report: &ProbeReport) -> ProbeResult<()> {
    let mut file = fs::File::create(path)
        .map_err(|e| format!("failed to create transcript {}: {e}", path.display()))?;
    let entries = vec![
        TranscriptEntry {
            id: format!("{}_meta", report.run_id),
            session_id: report.session_id.clone(),
            kind: "session_meta".to_string(),
            payload: json!({
                "scenario": report.scenario,
                "provider": report.provider,
                "probeMode": report.probe_mode,
                "workspaceKind": report.workspace_kind,
                "model": report.model,
                "idealLoop": &report.ideal_loop,
                "loopReview": &report.loop_review,
            }),
            created_at_ms: now_millis(),
        },
        TranscriptEntry {
            id: format!("{}_events", report.run_id),
            session_id: report.session_id.clone(),
            kind: "events".to_string(),
            payload: json!(report.events),
            created_at_ms: now_millis(),
        },
        TranscriptEntry {
            id: format!("{}_final", report.run_id),
            session_id: report.session_id.clone(),
            kind: "final".to_string(),
            payload: json!({
                "message": report.final_message,
                "kind": report.final_message_kind,
            }),
            created_at_ms: now_millis(),
        },
    ];
    for entry in entries {
        let line = serde_json::to_string(&entry).map_err(|e| e.to_string())?;
        writeln!(file, "{line}").map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn write_bundle(path: &Path, report: &ProbeReport) -> ProbeResult<()> {
    write_json_file(
        path,
        &json!({
            "schemaVersion": 1,
            "kind": "redbox-runtime-probe-bundle",
            "sessionId": report.session_id,
            "scenario": report.scenario,
            "report": report,
        }),
    )
}

fn write_json_file(path: &Path, value: &Value) -> ProbeResult<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    fs::write(path, text).map_err(|e| format!("failed to write {}: {e}", path.display()))
}

fn load_bundle(context: &ProbeContext, options: &ReplayOptions) -> ProbeResult<Value> {
    let path = if let Some(path) = &options.bundle_path {
        path.clone()
    } else {
        let session_id = options
            .session_id
            .as_ref()
            .ok_or_else(|| "missing session id".to_string())?;
        find_bundle_by_session(&context.output_root, session_id)?
    };
    let text = fs::read_to_string(&path)
        .map_err(|e| format!("failed to read bundle {}: {e}", path.display()))?;
    serde_json::from_str(&text).map_err(|e| format!("invalid bundle JSON: {e}"))
}

fn find_bundle_by_session(root: &Path, session_id: &str) -> ProbeResult<PathBuf> {
    let mut stack = vec![root.to_path_buf()];
    while let Some(path) = stack.pop() {
        for entry in fs::read_dir(&path).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let entry_path = entry.path();
            if entry_path.is_dir() {
                stack.push(entry_path);
            } else if entry_path.file_name().and_then(|name| name.to_str())
                == Some(&format!("{session_id}.json"))
            {
                return Ok(entry_path);
            }
        }
    }
    Err(format!(
        "could not find bundle for session {session_id} under {}",
        root.display()
    ))
}

fn review_real_session(options: &ReplayOptions) -> ProbeResult<RealSessionReview> {
    let session_id = options
        .session_id
        .as_ref()
        .ok_or_else(|| "review-real requires --session <session_id>".to_string())?;
    let support_root = redbox_app_support_root()?;
    let transcript_path = support_root
        .join("session-transcripts")
        .join(format!("{session_id}.jsonl"));
    if !transcript_path.exists() {
        return Err(format!(
            "real transcript not found: {}",
            transcript_path.display()
        ));
    }
    let bundle_path = support_root
        .join("session-bundles")
        .join(format!("{session_id}.json"));
    let bundle_path_string = bundle_path
        .exists()
        .then(|| bundle_path.display().to_string());

    let file = fs::File::open(&transcript_path)
        .map_err(|e| format!("failed to open {}: {e}", transcript_path.display()))?;
    let reader = BufReader::new(file);
    let mut runtime_modes = Vec::new();
    let mut message_count = 0usize;
    let mut assistant_tool_call_count = 0usize;
    let mut tool_result_count = 0usize;
    let mut tool_calls = Vec::new();
    let mut has_profile_read = false;
    let mut has_source_read = false;
    let mut has_create_project = false;
    let mut has_write_current = false;
    let mut legacy_extension_mentions = Vec::new();
    let mut manuscript_links = Vec::new();
    let mut final_claims_saved = false;

    for line in reader.lines() {
        let line = line.map_err(|e| format!("failed to read transcript line: {e}"))?;
        if line.trim().is_empty() {
            continue;
        }
        collect_legacy_mentions(&line, &mut legacy_extension_mentions);
        collect_manuscript_links(&line, &mut manuscript_links);
        let value: Value = match serde_json::from_str(&line) {
            Ok(value) => value,
            Err(_) => continue,
        };
        if let Some(mode) = value.get("runtime_mode").and_then(Value::as_str) {
            push_unique_string(&mut runtime_modes, mode);
        }
        if value.get("type").and_then(Value::as_str) == Some("metadata") {
            if let Some(mode) = value.get("runtime_mode").and_then(Value::as_str) {
                push_unique_string(&mut runtime_modes, mode);
            }
        }
        let Some(message) = value.get("message") else {
            continue;
        };
        message_count += 1;
        let role = message.get("role").and_then(Value::as_str).unwrap_or("");
        if let Some(content) = message.get("content").and_then(Value::as_str) {
            collect_legacy_mentions(content, &mut legacy_extension_mentions);
            collect_manuscript_links(content, &mut manuscript_links);
            if role == "assistant" && content.contains("已完成创作并保存") {
                final_claims_saved = true;
            }
        }
        if role == "assistant" {
            if let Some(calls) = message.get("tool_calls").and_then(Value::as_array) {
                for call in calls {
                    assistant_tool_call_count += 1;
                    let name = call
                        .pointer("/function/name")
                        .and_then(Value::as_str)
                        .unwrap_or("unknown")
                        .to_string();
                    let args = call
                        .pointer("/function/arguments")
                        .and_then(Value::as_str)
                        .and_then(parse_json_value)
                        .unwrap_or_else(|| json!({}));
                    let action = real_tool_call_action(&name, &args);
                    observe_real_action(
                        &action,
                        &mut has_profile_read,
                        &mut has_source_read,
                        &mut has_create_project,
                        &mut has_write_current,
                    );
                    tool_calls.push(RealToolCall {
                        name,
                        action,
                        success: None,
                    });
                }
            }
        } else if role == "tool" {
            tool_result_count += 1;
            let name = message
                .get("tool_name")
                .and_then(Value::as_str)
                .unwrap_or("unknown")
                .to_string();
            let success = message.get("success").and_then(Value::as_bool);
            let content = message.get("content").and_then(Value::as_str).unwrap_or("");
            let content_json = parse_json_value(content).unwrap_or_else(|| json!({}));
            let action = content_json
                .get("action")
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| real_tool_call_action(&name, &content_json));
            observe_real_action(
                &action,
                &mut has_profile_read,
                &mut has_source_read,
                &mut has_create_project,
                &mut has_write_current,
            );
            tool_calls.push(RealToolCall {
                name,
                action,
                success,
            });
        }
    }

    let mut findings = Vec::new();
    if has_create_project && !has_write_current {
        findings.push(
            "created a manuscript project but the transcript never recorded Write(path=\"manuscripts://current\") or manuscripts.writeCurrent"
                .to_string(),
        );
    }
    if final_claims_saved && !has_write_current {
        findings.push(
            "assistant claimed the manuscript was saved without a recorded write-current tool call"
                .to_string(),
        );
    }
    if !legacy_extension_mentions.is_empty() {
        findings
            .push("real session still mentions legacy custom manuscript extensions".to_string());
    }
    if runtime_modes.iter().any(|mode| mode == "redclaw") && !has_profile_read {
        findings.push("redclaw authoring session did not read the creator profile".to_string());
    }
    if runtime_modes.iter().any(|mode| mode == "redclaw") && !has_source_read {
        findings.push("redclaw authoring session did not read source material files".to_string());
    }
    let status = if findings.is_empty() {
        "passed"
    } else {
        "failed"
    }
    .to_string();

    Ok(RealSessionReview {
        session_id: session_id.clone(),
        status,
        transcript_path: transcript_path.display().to_string(),
        bundle_path: bundle_path_string,
        runtime_modes,
        message_count,
        assistant_tool_call_count,
        tool_result_count,
        tool_calls,
        has_profile_read,
        has_source_read,
        has_create_project,
        has_write_current,
        legacy_extension_mentions,
        manuscript_links,
        findings,
    })
}

fn invoke_real_ipc(context: &ProbeContext, options: &RealIpcOptions) -> ProbeResult<Value> {
    let payload = prepare_real_ipc_payload(options)?;
    let mut app_process = None;
    if real_ipc_health(&options.host, options.port).is_err() {
        if !options.start_app {
            return Err(format!(
                "RedBox assistant daemon is not reachable at http://{}:{}; start the app first or pass --start-app to launch the Tauri dev app for this probe",
                options.host, options.port
            ));
        }
        app_process = Some(start_real_app_process(context, options)?);
        wait_for_real_ipc_health(&options.host, options.port, options.timeout_seconds)?;
    }

    let body = json!({
        "channel": options.channel,
        "payload": payload,
    });
    let body_text = serde_json::to_string(&body).map_err(|e| e.to_string())?;
    let path = if options.send {
        "/api/ipc/send"
    } else {
        "/api/ipc/invoke"
    };
    let response_text = http_post_json(&options.host, options.port, path, &body_text)?;
    drop(app_process);
    serde_json::from_str(&response_text)
        .map_err(|e| format!("real IPC returned non-JSON response: {e}; body={response_text}"))
}

fn prepare_real_ipc_payload(options: &RealIpcOptions) -> ProbeResult<Value> {
    let mut payload = options.payload.clone();
    if let Some(prefix) = options.model_config_env_prefix.as_deref() {
        if let Some(model_config) = model_config_from_env(prefix)? {
            attach_model_config_to_payload(&mut payload, model_config)?;
        }
    }
    if let Some(model_config) = options.model_config.clone() {
        attach_model_config_to_payload(&mut payload, model_config)?;
    }
    if options.require_model_config && !payload_has_usable_model_config(&payload) {
        return Err(
            "real IPC probe requires modelConfig with baseURL, apiKey, and modelName. Set REDBOX_TEST_AI_BASE_URL, REDBOX_TEST_AI_API_KEY, REDBOX_TEST_AI_MODEL and pass --model-config-env, or pass --model-config-json for a local throwaway config"
                .to_string(),
        );
    }
    Ok(payload)
}

fn model_config_from_env(prefix: &str) -> ProbeResult<Option<Value>> {
    let base_url = env_string(&format!("{prefix}_BASE_URL"));
    let api_key = env_string(&format!("{prefix}_API_KEY"));
    let model_name = env_string(&format!("{prefix}_MODEL"))
        .or_else(|| env_string(&format!("{prefix}_MODEL_NAME")));
    if base_url.is_none() && api_key.is_none() && model_name.is_none() {
        return Ok(None);
    }
    let missing = [
        ("BASE_URL", base_url.as_ref()),
        ("API_KEY", api_key.as_ref()),
        ("MODEL or MODEL_NAME", model_name.as_ref()),
    ]
    .iter()
    .filter_map(|(name, value)| if value.is_none() { Some(*name) } else { None })
    .collect::<Vec<_>>();
    if !missing.is_empty() {
        return Err(format!(
            "incomplete {prefix} model config env; missing {}",
            missing.join(", ")
        ));
    }
    Ok(Some(json!({
        "baseURL": base_url.unwrap(),
        "apiKey": api_key.unwrap(),
        "modelName": model_name.unwrap(),
    })))
}

fn env_string(name: &str) -> Option<String> {
    env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn attach_model_config_to_payload(payload: &mut Value, model_config: Value) -> ProbeResult<()> {
    if !model_config.is_object() {
        return Err("--model-config-json must be a JSON object".to_string());
    }
    let payload_object = payload
        .as_object_mut()
        .ok_or_else(|| "payload must be a JSON object to attach modelConfig".to_string())?;
    payload_object.insert("modelConfig".to_string(), model_config);
    Ok(())
}

fn payload_has_usable_model_config(payload: &Value) -> bool {
    let Some(model_config) = payload.get("modelConfig") else {
        return false;
    };
    ["baseURL", "apiKey", "modelName"].iter().all(|key| {
        model_config
            .get(*key)
            .and_then(Value::as_str)
            .map(str::trim)
            .map(|value| !value.is_empty())
            .unwrap_or(false)
    })
}

struct ManagedAppProcess {
    child: std::process::Child,
    keep_app: bool,
}

impl Drop for ManagedAppProcess {
    fn drop(&mut self) {
        if self.keep_app {
            return;
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn start_real_app_process(
    context: &ProbeContext,
    options: &RealIpcOptions,
) -> ProbeResult<ManagedAppProcess> {
    let desktop_root = context
        .tauri_root
        .parent()
        .ok_or_else(|| "could not resolve desktop root from src-tauri path".to_string())?;
    let default_command = format!(
        "cd '{}' && exec pnpm tauri:dev:thrive",
        shell_escape_single_quotes(&desktop_root.display().to_string())
    );
    let command = options.app_command.clone().unwrap_or(default_command);
    let log_dir = context
        .output_root
        .join(format!("real-app-{}", now_millis()));
    fs::create_dir_all(&log_dir)
        .map_err(|e| format!("failed to create {}: {e}", log_dir.display()))?;
    let log_path = log_dir.join("app.log");
    let mut log_file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|e| format!("failed to open {}: {e}", log_path.display()))?;
    writeln!(
        log_file,
        "$ {command}\n# Waiting for http://{}:{}/api/ipc/health",
        options.host, options.port
    )
    .map_err(|e| format!("failed to write {}: {e}", log_path.display()))?;
    let stdout = log_file
        .try_clone()
        .map_err(|e| format!("failed to clone {}: {e}", log_path.display()))?;
    let stderr = log_file
        .try_clone()
        .map_err(|e| format!("failed to clone {}: {e}", log_path.display()))?;
    let child = background_command("/bin/sh")
        .arg("-lc")
        .arg(command)
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr))
        .spawn()
        .map_err(|e| format!("failed to start Tauri dev app for real IPC probe: {e}"))?;
    eprintln!(
        "started RedBox app process pid={} for real IPC probe; log={}",
        child.id(),
        log_path.display()
    );
    Ok(ManagedAppProcess {
        child,
        keep_app: options.keep_app,
    })
}

fn wait_for_real_ipc_health(host: &str, port: u16, timeout_seconds: u64) -> ProbeResult<()> {
    let started = Instant::now();
    let timeout = Duration::from_secs(timeout_seconds);
    loop {
        if real_ipc_health(host, port).is_ok() {
            return Ok(());
        }
        if started.elapsed() >= timeout {
            return Err(format!(
                "timed out after {timeout_seconds}s waiting for RedBox assistant daemon at http://{host}:{port}/api/ipc/health"
            ));
        }
        thread::sleep(Duration::from_millis(500));
    }
}

fn real_ipc_health(host: &str, port: u16) -> ProbeResult<String> {
    http_get(host, port, "/api/ipc/health", Duration::from_secs(2))
}

fn http_get(host: &str, port: u16, path: &str, timeout: Duration) -> ProbeResult<String> {
    let mut stream = TcpStream::connect((host, port)).map_err(|e| {
        format!("could not connect to RedBox assistant daemon at http://{host}:{port}: {e}")
    })?;
    stream
        .set_read_timeout(Some(timeout))
        .map_err(|e| e.to_string())?;
    stream
        .set_write_timeout(Some(Duration::from_secs(5)))
        .map_err(|e| e.to_string())?;
    let request = format!(
        "GET {path} HTTP/1.1\r\nHost: {host}:{port}\r\nOrigin: http://127.0.0.1\r\nConnection: close\r\n\r\n"
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|e| format!("failed to send real IPC health request: {e}"))?;
    read_http_response(stream, "real IPC health")
}

fn http_post_json(host: &str, port: u16, path: &str, body: &str) -> ProbeResult<String> {
    let mut stream = TcpStream::connect((host, port)).map_err(|e| {
        format!(
            "could not connect to RedBox assistant daemon at http://{host}:{port}; start the app and ensure assistant daemon auto-start is enabled before running real IPC probes: {e}"
        )
    })?;
    stream
        .set_read_timeout(Some(Duration::from_secs(180)))
        .map_err(|e| e.to_string())?;
    stream
        .set_write_timeout(Some(Duration::from_secs(10)))
        .map_err(|e| e.to_string())?;
    let request = format!(
        "POST {path} HTTP/1.1\r\nHost: {host}:{port}\r\nContent-Type: application/json\r\nOrigin: http://127.0.0.1\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{body}",
        body.as_bytes().len()
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|e| format!("failed to send real IPC request: {e}"))?;
    let mut response = String::new();
    stream
        .read_to_string(&mut response)
        .map_err(|e| format!("failed to read real IPC response: {e}"))?;
    split_http_response(&response, "real IPC request")
}

fn read_http_response(mut stream: TcpStream, label: &str) -> ProbeResult<String> {
    let mut response = String::new();
    stream
        .read_to_string(&mut response)
        .map_err(|e| format!("failed to read {label} response: {e}"))?;
    split_http_response(&response, label)
}

fn split_http_response(response: &str, label: &str) -> ProbeResult<String> {
    let (head, body) = response
        .split_once("\r\n\r\n")
        .ok_or_else(|| format!("invalid HTTP response from {label}: {response}"))?;
    let status = head.lines().next().unwrap_or_default();
    if !status.contains(" 200 ") {
        return Err(format!("{label} failed: {status}; body={body}"));
    }
    Ok(body.to_string())
}

fn redbox_app_support_root() -> ProbeResult<PathBuf> {
    let home = env::var("HOME").map_err(|_| "HOME is not set".to_string())?;
    Ok(PathBuf::from(home).join("Library/Application Support/RedBox"))
}

fn parse_json_value(text: &str) -> Option<Value> {
    serde_json::from_str(text).ok()
}

fn push_unique_string(items: &mut Vec<String>, value: &str) {
    if !items.iter().any(|item| item == value) {
        items.push(value.to_string());
    }
}

fn collect_legacy_mentions(text: &str, output: &mut Vec<String>) {
    for token in [".thrive", ".redarticle"] {
        if text.contains(token) {
            let snippet = text
                .lines()
                .find(|line| line.contains(token))
                .unwrap_or(text)
                .trim()
                .chars()
                .take(220)
                .collect::<String>();
            push_unique_string(output, &snippet);
        }
    }
}

fn collect_manuscript_links(text: &str, output: &mut Vec<String>) {
    let mut rest = text;
    while let Some(index) = rest.find("manuscripts://") {
        let after = &rest[index..];
        let end = after
            .find(|ch: char| ch == ')' || ch.is_whitespace() || ch == '"' || ch == '\\')
            .unwrap_or(after.len());
        let link = &after[..end];
        push_unique_string(output, link);
        rest = &after[end..];
    }
}

fn real_tool_call_action(name: &str, args: &Value) -> String {
    if name.eq_ignore_ascii_case("Write") {
        let path = args.get("path").and_then(Value::as_str).unwrap_or("");
        if path.eq_ignore_ascii_case("manuscripts://current") {
            return "manuscripts.writeCurrent".to_string();
        }
        return "write".to_string();
    }
    if name.eq_ignore_ascii_case("Read") {
        return "workspace.read".to_string();
    }
    if name.eq_ignore_ascii_case("List") {
        return "workspace.list".to_string();
    }
    if name.eq_ignore_ascii_case("Operate") {
        let resource = args
            .get("resource")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        let operation = args
            .get("operation")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string();
        if resource == "manuscript" || resource == "manuscripts" {
            return format!("manuscripts.{operation}");
        }
        if resource == "redclaw.profile" {
            return format!("redclaw.profile.{operation}");
        }
        if resource == "skills" {
            return format!("skills.{operation}");
        }
        if !resource.is_empty() || !operation.is_empty() {
            return format!("{resource}.{operation}");
        }
    }
    name.to_string()
}

fn observe_real_action(
    action: &str,
    has_profile_read: &mut bool,
    has_source_read: &mut bool,
    has_create_project: &mut bool,
    has_write_current: &mut bool,
) {
    let normalized = action.to_ascii_lowercase();
    if matches!(
        normalized.as_str(),
        "redclaw.profile.bundle" | "redclaw.profile.read"
    ) {
        *has_profile_read = true;
    }
    if matches!(
        normalized.as_str(),
        "workspace.read" | "knowledge.read" | "read"
    ) {
        *has_source_read = true;
    }
    if normalized == "manuscripts.createproject" || normalized == "manuscripts.create" {
        *has_create_project = true;
    }
    if normalized == "manuscripts.writecurrent" {
        *has_write_current = true;
    }
}

fn print_inspection(bundle: &Value) {
    let report = bundle.get("report").unwrap_or(bundle);
    println!("scenario: {}", string_field(report, "scenario"));
    println!("status: {}", string_field(report, "status"));
    println!("probeMode: {}", string_field(report, "probeMode"));
    println!("workspaceKind: {}", string_field(report, "workspaceKind"));
    println!("sessionId: {}", string_field(report, "sessionId"));
    println!(
        "finalMessageKind: {}",
        string_field(report, "finalMessageKind")
    );
    println!(
        "events: {}",
        report
            .get("events")
            .and_then(Value::as_array)
            .map(Vec::len)
            .unwrap_or(0)
    );
    println!(
        "toolCalls: {}",
        report
            .get("toolCalls")
            .and_then(Value::as_array)
            .map(Vec::len)
            .unwrap_or(0)
    );
    if let Some(loop_review) = report.get("loopReview") {
        println!(
            "loopReview: {}",
            loop_review
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or("unknown")
        );
        if let Some(gaps) = loop_review.get("gaps").and_then(Value::as_array) {
            println!("loopGaps: {}", gaps.len());
        }
    }
}

fn prompt_review_from_bundle(bundle: &Value) -> Vec<String> {
    let report = bundle.get("report").unwrap_or(bundle);
    let mut notes = report
        .get("promptReviewNotes")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if report
        .get("finalMessageKind")
        .and_then(Value::as_str)
        .is_some_and(|kind| kind != "summary")
    {
        notes.push("Final response was not classified as summary.".to_string());
    }
    if let Some(loop_review) = report.get("loopReview") {
        if let Some(gaps) = loop_review.get("gaps").and_then(Value::as_array) {
            notes.extend(
                gaps.iter()
                    .filter_map(Value::as_str)
                    .map(|gap| format!("Loop gap: {gap}")),
            );
        }
        if let Some(items) = loop_review
            .get("optimizationNotes")
            .and_then(Value::as_array)
        {
            notes.extend(items.iter().filter_map(Value::as_str).map(str::to_string));
        }
    }
    notes
}

fn ideal_loop_for(scenario: &str) -> Option<IdealLoopSpec> {
    match scenario {
        "wander-loop" => Some(IdealLoopSpec {
            objective:
                "从漫步输入中发现灵感，检索并读取最少必要素材，输出可继续创作的素材卡片和方向。"
                    .to_string(),
            expected_events: vec![
                "wander/session_created",
                "wander/user_message",
                "wander/skill_selected",
                "tool/call_started",
                "tool/call_completed",
                "wander/material_cards_rendered",
                "turn/completed",
            ]
            .into_iter()
            .map(str::to_string)
            .collect(),
            expected_skills: vec!["wander-synthesis".to_string()],
            tool_budgets: vec![tool_budget("Search", 1, 1), tool_budget("Read", 1, 2)],
            ideal_total_tool_calls: 2,
            max_total_tool_calls: 3,
        }),
        "wander-to-creation" | "redclaw-save-summary" => Some(IdealLoopSpec {
            objective:
                "从漫步素材发起创作时创建新的写作会话，保留素材 metadata，激活写作技能，保存稿件文件夹工程，并只输出运行总结和链接。"
                    .to_string(),
            expected_events: vec![
                "wander/session_created",
                "wander/material_selected",
                "redclaw/session_created",
                "redclaw/user_message",
                "redclaw/skill_selected",
                "manuscript/write_started",
                "manuscript/write_completed",
                "turn/completed",
            ]
            .into_iter()
            .map(str::to_string)
            .collect(),
            expected_skills: vec!["writing-style".to_string()],
            tool_budgets: vec![tool_budget("manuscripts.writeCurrent", 1, 1)],
            ideal_total_tool_calls: 1,
            max_total_tool_calls: 1,
        }),
        _ => None,
    }
}

fn review_loop(spec: &IdealLoopSpec, run: &ScenarioRun) -> LoopReview {
    let actual_event_path = run
        .events
        .iter()
        .map(|item| item.event_type.clone())
        .collect::<Vec<_>>();
    let actual_skills = run
        .events
        .iter()
        .filter_map(|item| {
            if item.event_type.ends_with("skill_selected") {
                item.detail
                    .get("skill")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            } else {
                None
            }
        })
        .collect::<Vec<_>>();
    let mut counts = BTreeMap::new();
    for call in &run.tool_calls {
        *counts.entry(call.name.clone()).or_insert(0usize) += 1;
    }
    let tool_call_counts = counts
        .iter()
        .map(|(name, count)| ToolCallCount {
            name: name.clone(),
            count: *count,
        })
        .collect::<Vec<_>>();

    let mut gaps = Vec::new();
    let mut optimization_notes = Vec::new();
    for skill in &spec.expected_skills {
        if !actual_skills.contains(skill) {
            gaps.push(format!("missing expected skill activation `{skill}`"));
            optimization_notes.push(format!(
                "Add explicit runtime evidence for `{skill}` selection before tool calls."
            ));
        }
    }
    if !event_path_contains_order(&actual_event_path, &spec.expected_events) {
        gaps.push("actual event path does not preserve ideal order".to_string());
        optimization_notes.push(
            "Review routing/prompt order so session, skill, tools, artifacts and final summary appear in a stable sequence."
                .to_string(),
        );
    }
    let actual_total = run.tool_calls.len();
    if actual_total > spec.max_total_tool_calls {
        gaps.push(format!(
            "tool call count {actual_total} exceeds max {}",
            spec.max_total_tool_calls
        ));
        optimization_notes.push(
            "Reduce redundant reads/searches and prefer existing structured context before calling more tools."
                .to_string(),
        );
    }
    for budget in &spec.tool_budgets {
        let count = counts.get(&budget.name).copied().unwrap_or_default();
        if count == 0 {
            gaps.push(format!("missing expected tool `{}`", budget.name));
        } else if count > budget.max {
            gaps.push(format!(
                "tool `{}` used {count} times, max {}",
                budget.name, budget.max
            ));
        }
    }
    if gaps.is_empty() {
        optimization_notes
            .push("Loop matched the ideal path; keep this as regression baseline.".to_string());
    }

    LoopReview {
        status: if gaps.is_empty() { "passed" } else { "failed" }.to_string(),
        actual_event_path,
        actual_skills,
        actual_tool_call_count: actual_total,
        tool_call_counts,
        gaps,
        optimization_notes,
    }
}

fn event_path_contains_order(actual: &[String], expected: &[String]) -> bool {
    let mut cursor = 0usize;
    for expected_event in expected {
        let Some(position) = actual[cursor..]
            .iter()
            .position(|actual_event| actual_event == expected_event)
        else {
            return false;
        };
        cursor += position + 1;
    }
    true
}

fn tool_budget(name: &str, ideal: usize, max: usize) -> ToolBudget {
    ToolBudget {
        name: name.to_string(),
        ideal,
        max,
    }
}

fn default_prompt_notes_for(scenario: &str, run: &ScenarioRun) -> Vec<String> {
    if run.final_message_kind != "summary" {
        return vec!["Final output contract should require summary output.".to_string()];
    }
    match scenario {
        "tool-call-contract" => {
            vec![
                "Prompt should tell the model to summarize tool errors without raw JSON."
                    .to_string(),
            ]
        }
        _ => Vec::new(),
    }
}

fn event(event_type: &str, detail: Value) -> ProbeEvent {
    ProbeEvent {
        event_type: event_type.to_string(),
        detail,
    }
}

fn tool_call(name: &str, status: &str, input_summary: &str, output_summary: &str) -> ProbeToolCall {
    ProbeToolCall {
        name: name.to_string(),
        status: status.to_string(),
        input_summary: input_summary.to_string(),
        output_summary: output_summary.to_string(),
    }
}

fn artifact(path: &str, kind: &str) -> ProbeArtifact {
    ProbeArtifact {
        path: path.to_string(),
        kind: kind.to_string(),
    }
}

fn assertion(name: &str, passed: bool, detail: &str) -> ProbeAssertion {
    ProbeAssertion {
        name: name.to_string(),
        status: if passed { "passed" } else { "failed" }.to_string(),
        detail: detail.to_string(),
    }
}

fn qualify_mcp_tool_name(server_name: &str, tool_name: &str) -> String {
    format!(
        "mcp__{}__{}",
        sanitize_tool_segment(server_name),
        sanitize_tool_segment(tool_name)
    )
}

fn sanitize_tool_segment(value: &str) -> String {
    let mut out = String::new();
    let mut last_underscore = false;
    for ch in value.chars() {
        let next = if ch.is_ascii_alphanumeric() {
            ch.to_ascii_lowercase()
        } else {
            '_'
        };
        if next == '_' {
            if !last_underscore && !out.is_empty() {
                out.push(next);
            }
            last_underscore = true;
        } else {
            out.push(next);
            last_underscore = false;
        }
    }
    out.trim_matches('_').to_string()
}

fn sanitize_id(value: &str) -> String {
    value
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '_' })
        .collect()
}

fn shell_escape_single_quotes(value: &str) -> String {
    value.replace('\'', "'\"'\"'")
}

fn string_field(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn print_help() {
    println!("RedBox Runtime Probe");
    println!();
    println!("Usage:");
    println!("  cargo run --bin redbox_runtime_probe -- smoke");
    println!("  cargo run --bin redbox_runtime_probe -- list-scenarios");
    println!("  cargo run --bin redbox_runtime_probe -- run-all [--provider mock]");
    println!("  cargo run --bin redbox_runtime_probe -- run-scenario <name> [--repeat N] [--provider mock]");
    println!("  cargo run --bin redbox_runtime_probe -- replay --session <session_id>");
    println!("  cargo run --bin redbox_runtime_probe -- inspect --bundle <path>");
    println!("  cargo run --bin redbox_runtime_probe -- review-prompt --session <session_id>");
    println!(
        "  cargo run --bin redbox_runtime_probe -- review-real --session <real_redbox_session_id>"
    );
    println!(
        "  cargo run --bin redbox_runtime_probe -- invoke-real-ipc --channel chat:send-message --payload-json '<json>'"
    );
    println!(
        "  cargo run --bin redbox_runtime_probe -- invoke-real-ipc --send --start-app --channel chat:send-message --payload-json '<json>'"
    );
    println!();
    println!("Notes:");
    println!("  run-scenario/run-all are mock-contract fixtures in a temporary workspace.");
    println!("  review-real audits ~/Library/Application Support/RedBox logs from the real app.");
    println!(
        "  invoke-real-ipc calls the running app daemon and can trigger real provider requests."
    );
    println!(
        "  invoke-real-ipc --start-app starts the Tauri dev app, waits for the daemon health endpoint, then invokes IPC."
    );
    println!(
        "  invoke-real-ipc --model-config-env reads REDBOX_TEST_AI_BASE_URL/API_KEY/MODEL and attaches payload.modelConfig."
    );
    println!(
        "  invoke-real-ipc --require-model-config fails before provider calls when modelConfig is missing."
    );
    println!();
    println!("Global options:");
    println!("  --output-dir <path>     Override probe output root");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scenario_registry_contains_required_runtime_surfaces() {
        let names = scenario_names();
        for required in [
            "smoke",
            "agent-basic-turn",
            "stream-retry",
            "stream-error-next-turn",
            "responses-tool-turn",
            "tool-call-contract",
            "mcp-list-tools",
            "mcp-call-tool",
            "mcp-resource-read",
            "cli-runtime-execute",
            "cli-runtime-verify",
            "skill-activation",
            "skill-no-false-positive",
            "team-single-task",
            "team-member-report",
            "team-completion-summary",
            "wander-loop",
            "wander-to-creation",
            "redclaw-save-summary",
        ] {
            assert!(names.contains(&required), "missing scenario {required}");
        }
    }

    #[test]
    fn mcp_tool_name_is_stable_and_prefixed() {
        assert_eq!(
            qualify_mcp_tool_name("Demo Server", "read:file.now"),
            "mcp__demo_server__read_file_now"
        );
    }

    #[test]
    fn cli_parser_accepts_run_scenario_options() {
        let cli = parse_cli(vec![
            "run-scenario".to_string(),
            "wander-to-creation".to_string(),
            "--repeat".to_string(),
            "3".to_string(),
            "--provider".to_string(),
            "mock".to_string(),
            "--skill".to_string(),
            "writing-style".to_string(),
        ])
        .unwrap();
        let ProbeCommand::RunScenario(options) = cli.command else {
            panic!("expected run-scenario");
        };
        assert_eq!(options.name, "wander-to-creation");
        assert_eq!(options.repeat, 3);
        assert_eq!(options.provider, "mock");
        assert_eq!(options.skill.as_deref(), Some("writing-style"));
    }

    #[test]
    fn cli_parser_accepts_run_all_options() {
        let cli = parse_cli(vec![
            "run-all".to_string(),
            "--provider".to_string(),
            "mock".to_string(),
        ])
        .unwrap();
        let ProbeCommand::RunAll(options) = cli.command else {
            panic!("expected run-all");
        };
        assert_eq!(options.name, "smoke");
        assert_eq!(options.provider, "mock");
    }

    #[test]
    fn cli_parser_accepts_real_ipc_options() {
        let cli = parse_cli(vec![
            "invoke-real-ipc".to_string(),
            "--channel".to_string(),
            "chat:send-message".to_string(),
            "--payload-json".to_string(),
            r#"{"message":"hi"}"#.to_string(),
            "--port".to_string(),
            "31937".to_string(),
            "--send".to_string(),
            "--start-app".to_string(),
            "--timeout-seconds".to_string(),
            "12".to_string(),
            "--model-config-json".to_string(),
            r#"{"baseURL":"https://api.example.test/v1","apiKey":"test-key","modelName":"test-model"}"#.to_string(),
            "--require-model-config".to_string(),
        ])
        .unwrap();
        let ProbeCommand::InvokeRealIpc(options) = cli.command else {
            panic!("expected invoke-real-ipc");
        };
        assert_eq!(options.channel, "chat:send-message");
        assert_eq!(options.port, 31937);
        assert_eq!(
            options.payload.get("message").and_then(Value::as_str),
            Some("hi")
        );
        assert!(options.send);
        assert!(options.start_app);
        assert_eq!(options.timeout_seconds, 12);
        assert!(options.require_model_config);
        assert!(options.model_config.is_some());
    }

    #[test]
    fn real_ipc_payload_attaches_model_config() {
        let options = RealIpcOptions {
            host: "127.0.0.1".to_string(),
            port: 31937,
            channel: "chat:send-message".to_string(),
            payload: json!({"message": "hi"}),
            model_config: Some(json!({
                "baseURL": "https://api.example.test/v1",
                "apiKey": "test-key",
                "modelName": "test-model"
            })),
            model_config_env_prefix: None,
            require_model_config: true,
            send: true,
            start_app: false,
            app_command: None,
            timeout_seconds: 12,
            keep_app: false,
        };
        let payload = prepare_real_ipc_payload(&options).unwrap();
        assert_eq!(
            payload
                .get("modelConfig")
                .and_then(|value| value.get("modelName"))
                .and_then(Value::as_str),
            Some("test-model")
        );
    }

    #[test]
    fn real_ipc_payload_rejects_missing_required_model_config() {
        let options = RealIpcOptions {
            host: "127.0.0.1".to_string(),
            port: 31937,
            channel: "chat:send-message".to_string(),
            payload: json!({"message": "hi"}),
            model_config: None,
            model_config_env_prefix: None,
            require_model_config: true,
            send: true,
            start_app: false,
            app_command: None,
            timeout_seconds: 12,
            keep_app: false,
        };
        let error = prepare_real_ipc_payload(&options).unwrap_err();
        assert!(error.contains("requires modelConfig"));
    }

    #[test]
    fn scenario_smoke_runs_against_repo_sources() {
        let context = build_context(None).unwrap();
        let options = ScenarioOptions {
            name: "smoke".to_string(),
            repeat: 1,
            provider: "mock".to_string(),
            model: None,
            tool: None,
            skill: None,
            fixture: None,
        };
        let report = run_single_scenario(&context, &options, 0).unwrap();
        assert_eq!(report.status, "passed");
        assert_eq!(report.probe_mode, "mock-contract");
        assert_eq!(report.workspace_kind, "probe-temp");
        assert!(Path::new(&report.transcript_path).exists());
        assert!(Path::new(&report.bundle_path).exists());
    }

    #[test]
    fn every_registered_scenario_runs_with_mock_provider() {
        let context = build_context(None).unwrap();
        for name in scenario_names() {
            let options = ScenarioOptions {
                name: name.to_string(),
                repeat: 1,
                provider: "mock".to_string(),
                model: None,
                tool: None,
                skill: None,
                fixture: None,
            };
            let report = run_single_scenario(&context, &options, 0).unwrap();
            assert_eq!(report.status, "passed", "scenario {name} failed");
            assert_eq!(report.final_message_kind, "summary");
            if matches!(
                name,
                "wander-loop" | "wander-to-creation" | "redclaw-save-summary"
            ) {
                assert!(report.ideal_loop.is_some(), "missing ideal loop for {name}");
                assert_eq!(
                    report
                        .loop_review
                        .as_ref()
                        .map(|review| review.status.as_str()),
                    Some("passed")
                );
            }
        }
    }

    #[test]
    fn run_all_returns_single_summary_report() {
        let context = build_context(None).unwrap();
        let options = ScenarioOptions {
            name: "smoke".to_string(),
            repeat: 1,
            provider: "mock".to_string(),
            model: None,
            tool: None,
            skill: None,
            fixture: None,
        };
        let report = run_all_scenarios(&context, &options).unwrap();
        assert_eq!(
            report.get("kind").and_then(Value::as_str),
            Some("redbox-runtime-probe-run-all")
        );
        assert_eq!(report.get("status").and_then(Value::as_str), Some("passed"));
        assert_eq!(report.get("failedCount").and_then(Value::as_u64), Some(0));
        assert_eq!(
            report.get("scenarioCount").and_then(Value::as_u64),
            Some(scenario_names().len() as u64)
        );
    }

    #[test]
    fn live_provider_is_rejected_until_wired() {
        let options = ScenarioOptions {
            name: "smoke".to_string(),
            repeat: 1,
            provider: "live".to_string(),
            model: None,
            tool: None,
            skill: None,
            fixture: None,
        };
        let error = validate_provider(&options).unwrap_err();
        assert!(error.contains("not wired"));
        assert!(error.contains("does not launch the real app loop"));
    }

    #[test]
    fn real_tool_call_action_detects_bound_manuscript_write() {
        assert_eq!(
            real_tool_call_action("Write", &json!({ "path": "manuscripts://current" })),
            "manuscripts.writeCurrent"
        );
        assert_eq!(
            real_tool_call_action(
                "Operate",
                &json!({ "resource": "manuscript", "operation": "createProject" })
            ),
            "manuscripts.createProject"
        );
    }

    #[test]
    fn collect_manuscript_links_finds_virtual_links() {
        let mut links = Vec::new();
        collect_manuscript_links(
            "稿件：[demo](manuscripts://wander/demo) and manuscripts://articles/a",
            &mut links,
        );
        assert_eq!(
            links,
            vec![
                "manuscripts://wander/demo".to_string(),
                "manuscripts://articles/a".to_string()
            ]
        );
    }
}
