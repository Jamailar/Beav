pub mod limits;
pub mod rpc;
pub mod tool_bridge;

pub use limits::*;
pub use rpc::*;
pub use tool_bridge::*;

use std::fs;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use serde_json::{json, Map, Value};

use crate::make_id;

struct ExecutionState {
    execution_id: String,
    stdout: String,
    stdout_truncated: bool,
    artifact_paths: Vec<String>,
    tool_call_count: usize,
    step_count: usize,
    suppressed_tool_output_chars: usize,
    executed_tools: Vec<String>,
    step_summaries: Vec<ScriptStepSummary>,
    env: Map<String, Value>,
    limits: ScriptExecutionLimits,
    temp_workspace: PathBuf,
    deadline: Instant,
}

impl ExecutionState {
    fn new(
        runtime_mode: &str,
        inputs: &Value,
        limits: ScriptExecutionLimits,
    ) -> Result<Self, String> {
        let execution_id = make_id("script");
        let temp_workspace = std::env::temp_dir().join(format!("lexbox-script-{execution_id}"));
        fs::create_dir_all(&temp_workspace).map_err(|error| error.to_string())?;
        let mut env = Map::new();
        env.insert("runtimeMode".to_string(), json!(runtime_mode));
        env.insert(
            "tempWorkspace".to_string(),
            json!(temp_workspace.display().to_string()),
        );
        env.insert("stdout".to_string(), json!(""));
        if let Some(object) = inputs.as_object() {
            for (key, value) in object {
                env.insert(key.clone(), value.clone());
            }
        }
        let deadline = Instant::now()
            .checked_add(Duration::from_millis(limits.timeout_ms))
            .ok_or_else(|| "script runtime timeout overflow".to_string())?;
        Ok(Self {
            execution_id,
            stdout: String::new(),
            stdout_truncated: false,
            artifact_paths: Vec::new(),
            tool_call_count: 0,
            step_count: 0,
            suppressed_tool_output_chars: 0,
            executed_tools: Vec::new(),
            step_summaries: Vec::new(),
            env,
            limits,
            temp_workspace,
            deadline,
        })
    }

    fn ensure_budget(&self) -> Result<(), String> {
        if Instant::now() > self.deadline {
            return Err("script runtime timed out".to_string());
        }
        if self.step_count >= self.limits.max_steps {
            return Err("script runtime exceeded maxSteps budget".to_string());
        }
        Ok(())
    }

    fn record_step(&mut self, id: Option<String>, op: &str, label: String, detail: String) {
        self.step_summaries.push(ScriptStepSummary {
            id,
            op: op.to_string(),
            label,
            status: "completed".to_string(),
            detail,
        });
    }

    fn push_stdout(&mut self, text: &str) {
        if self.stdout_truncated || text.is_empty() {
            return;
        }
        let current = self.stdout.chars().count();
        let remaining = self.limits.max_stdout_chars.saturating_sub(current);
        if remaining == 0 {
            self.stdout_truncated = true;
            return;
        }
        let chunk = text.chars().take(remaining).collect::<String>();
        self.stdout.push_str(&chunk);
        if text.chars().count() > remaining {
            self.stdout_truncated = true;
        }
        self.env
            .insert("stdout".to_string(), json!(self.stdout.clone()));
    }

    fn record_tool_result(&mut self, tool: &str, result: &Value) -> Result<(), String> {
        self.tool_call_count += 1;
        if self.tool_call_count > self.limits.max_tool_calls {
            return Err("script runtime exceeded maxToolCalls budget".to_string());
        }
        self.executed_tools.push(tool.to_string());
        let serialized = serde_json::to_string(result).unwrap_or_default();
        self.suppressed_tool_output_chars += serialized.chars().count();
        self.env.insert("last".to_string(), result.clone());
        Ok(())
    }

    fn write_artifact(&mut self, relative_path: &str, content: &str) -> Result<String, String> {
        if self.artifact_paths.len() >= self.limits.max_artifacts {
            return Err("script runtime exceeded maxArtifacts budget".to_string());
        }
        let sanitized = sanitize_artifact_relative_path(relative_path)?;
        let target = self.temp_workspace.join(&sanitized);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let bounded = content
            .chars()
            .take(self.limits.max_artifact_chars)
            .collect::<String>();
        fs::write(&target, bounded).map_err(|error| error.to_string())?;
        let path = target.display().to_string();
        self.artifact_paths.push(path.clone());
        self.env
            .insert("lastArtifactPath".to_string(), json!(path.clone()));
        Ok(path)
    }
}

fn sanitize_artifact_relative_path(path: &str) -> Result<PathBuf, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("artifact path is required".to_string());
    }
    if trimmed.starts_with('/') || trimmed.starts_with('~') {
        return Err("artifact path must stay relative to temp workspace".to_string());
    }
    let normalized = trimmed.replace('\\', "/");
    if normalized
        .split('/')
        .any(|segment| segment.trim().is_empty() || segment == "..")
    {
        return Err("artifact path may not escape temp workspace".to_string());
    }
    Ok(PathBuf::from(normalized))
}

fn lookup_path<'a>(value: &'a Value, expr: &str) -> Option<&'a Value> {
    let mut current = value;
    for segment in expr.split('.') {
        if segment.trim().is_empty() {
            continue;
        }
        match current {
            Value::Object(object) => {
                current = object.get(segment)?;
            }
            Value::Array(items) => {
                let index = segment.parse::<usize>().ok()?;
                current = items.get(index)?;
            }
            _ => return None,
        }
    }
    Some(current)
}

fn render_value_as_text(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(text) => text.clone(),
        other => serde_json::to_string(other).unwrap_or_default(),
    }
}

fn render_template_string(template: &str, env: &Value) -> Result<Value, String> {
    let trimmed = template.trim();
    if trimmed.starts_with("{{") && trimmed.ends_with("}}") && trimmed.matches("{{").count() == 1 {
        let expr = trimmed
            .trim_start_matches("{{")
            .trim_end_matches("}}")
            .trim();
        let value = lookup_path(env, expr)
            .cloned()
            .ok_or_else(|| format!("script runtime missing template value: {expr}"))?;
        return Ok(value);
    }

    let mut rendered = String::new();
    let mut rest = template;
    loop {
        let Some(start) = rest.find("{{") else {
            rendered.push_str(rest);
            break;
        };
        let (prefix, after_prefix) = rest.split_at(start);
        rendered.push_str(prefix);
        let after_open = &after_prefix[2..];
        let Some(end) = after_open.find("}}") else {
            return Err("unterminated template placeholder".to_string());
        };
        let (expr, after_expr) = after_open.split_at(end);
        let value = lookup_path(env, expr.trim())
            .ok_or_else(|| format!("script runtime missing template value: {}", expr.trim()))?;
        rendered.push_str(&render_value_as_text(value));
        rest = &after_expr[2..];
    }
    Ok(Value::String(rendered))
}

fn render_template_value(value: &Value, env: &Value) -> Result<Value, String> {
    match value {
        Value::String(template) => render_template_string(template, env),
        Value::Array(items) => {
            let mut rendered = Vec::with_capacity(items.len());
            for item in items {
                rendered.push(render_template_value(item, env)?);
            }
            Ok(Value::Array(rendered))
        }
        Value::Object(object) => {
            let mut rendered = Map::new();
            for (key, item) in object {
                rendered.insert(key.clone(), render_template_value(item, env)?);
            }
            Ok(Value::Object(rendered))
        }
        other => Ok(other.clone()),
    }
}

fn collect_tool_names(steps: &[ScriptStep], names: &mut Vec<String>) {
    for step in steps {
        match step {
            ScriptStep::Tool { tool, .. } => names.push(tool.clone()),
            ScriptStep::ForEach { steps, .. } => collect_tool_names(steps, names),
            ScriptStep::StdoutWrite { .. } | ScriptStep::ArtifactWrite { .. } => {}
        }
    }
}

pub fn validate_program_for_runtime_mode(
    program: &ScriptProgram,
    runtime_mode: &str,
) -> Result<(), String> {
    if program.version != SCRIPT_RUNTIME_PROGRAM_VERSION {
        return Err(format!(
            "unsupported script runtime version: {}",
            if program.version.trim().is_empty() {
                "<empty>"
            } else {
                program.version.as_str()
            }
        ));
    }
    if program.steps.is_empty() {
        return Err("script runtime requires at least one step".to_string());
    }
    let allowed = allowed_script_tools_for_runtime_mode(runtime_mode)
        .into_iter()
        .map(ToString::to_string)
        .collect::<Vec<_>>();
    let mut tools = Vec::new();
    collect_tool_names(&program.steps, &mut tools);
    for tool in tools {
        if !allowed.iter().any(|allowed_tool| allowed_tool == &tool) {
            return Err(format!(
                "script runtime tool `{tool}` is not allowed in runtime mode `{runtime_mode}`"
            ));
        }
    }
    Ok(())
}

fn execute_steps<B: ScriptToolBridge>(
    bridge: &mut B,
    steps: &[ScriptStep],
    state: &mut ExecutionState,
) -> Result<(), String> {
    for step in steps {
        state.ensure_budget()?;
        state.step_count += 1;
        let env_value = Value::Object(state.env.clone());
        match step {
            ScriptStep::Tool {
                id,
                tool,
                input,
                save_as,
            } => {
                let rendered_input = render_template_value(input, &env_value)?;
                let result = bridge.call(tool, rendered_input)?;
                state.record_tool_result(tool, &result)?;
                if let Some(alias) = save_as {
                    state.env.insert(alias.clone(), result.clone());
                }
                state.record_step(
                    id.clone(),
                    "tool",
                    tool.clone(),
                    format!("tool call {} completed", tool),
                );
            }
            ScriptStep::StdoutWrite { id, text } => {
                let rendered = render_template_string(text, &env_value)?;
                let as_text = render_value_as_text(&rendered);
                state.push_stdout(&as_text);
                state.record_step(
                    id.clone(),
                    "stdout_write",
                    "stdout".to_string(),
                    format!("stdout +{} chars", as_text.chars().count()),
                );
            }
            ScriptStep::ArtifactWrite {
                id,
                path,
                content,
                save_as,
            } => {
                let rendered_path = render_template_string(path, &env_value)?;
                let rendered_content = render_template_string(content, &env_value)?;
                let path_text = render_value_as_text(&rendered_path);
                let content_text = render_value_as_text(&rendered_content);
                let artifact_path = state.write_artifact(&path_text, &content_text)?;
                if let Some(alias) = save_as {
                    state
                        .env
                        .insert(alias.clone(), json!(artifact_path.clone()));
                }
                state.record_step(
                    id.clone(),
                    "artifact_write",
                    path_text,
                    format!("artifact saved to {}", artifact_path),
                );
            }
            ScriptStep::ForEach {
                id,
                items,
                item_as,
                max_items,
                steps,
            } => {
                let Some(iterable) = lookup_path(&env_value, items) else {
                    return Err(format!("script runtime loop source not found: {items}"));
                };
                let array = iterable.as_array().ok_or_else(|| {
                    format!("script runtime loop source is not an array: {items}")
                })?;
                let loop_limit = max_items
                    .unwrap_or(state.limits.max_loop_items)
                    .clamp(1, state.limits.max_loop_items);
                let alias = item_as.clone().unwrap_or_else(|| "item".to_string());
                for (index, item) in array.iter().take(loop_limit).enumerate() {
                    state.ensure_budget()?;
                    let previous = state.env.insert(alias.clone(), item.clone());
                    state.env.insert("itemIndex".to_string(), json!(index));
                    execute_steps(bridge, steps, state)?;
                    if let Some(previous) = previous {
                        state.env.insert(alias.clone(), previous);
                    } else {
                        state.env.remove(&alias);
                    }
                }
                state.env.remove("itemIndex");
                state.record_step(
                    id.clone(),
                    "for_each",
                    items.clone(),
                    format!("looped over {} items", array.len().min(loop_limit)),
                );
            }
        }
    }
    Ok(())
}

pub fn execute_script_with_bridge<B: ScriptToolBridge>(
    bridge: &mut B,
    request: &ScriptExecutionRequest,
    limits: ScriptExecutionLimits,
) -> Result<ScriptExecutionResult, String> {
    validate_program_for_runtime_mode(&request.program, &request.runtime_mode)?;
    let mut state = ExecutionState::new(&request.runtime_mode, &request.inputs, limits.clone())?;
    let execution = execute_steps(bridge, &request.program.steps, &mut state);
    let error_summary = execution.err();
    let success = error_summary.is_none();
    let estimated_prompt_reduction_chars = state
        .suppressed_tool_output_chars
        .saturating_sub(state.stdout.chars().count());
    Ok(ScriptExecutionResult {
        success,
        execution_id: state.execution_id,
        runtime_mode: request.runtime_mode.clone(),
        stdout: state.stdout,
        stdout_truncated: state.stdout_truncated,
        artifact_paths: state.artifact_paths,
        tool_call_count: state.tool_call_count,
        step_count: state.step_count,
        temp_workspace: state.temp_workspace.display().to_string(),
        error_summary,
        estimated_prompt_reduction_chars,
        executed_tools: state.executed_tools,
        step_summaries: state.step_summaries,
        limit_summary: json!(limits),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;
    use std::thread;
    use std::time::Duration;

    struct MockBridge {
        responses: VecDeque<(String, Value)>,
    }

    impl MockBridge {
        fn new(responses: Vec<(String, Value)>) -> Self {
            Self {
                responses: responses.into(),
            }
        }
    }

    impl ScriptToolBridge for MockBridge {
        fn call(&mut self, tool: &str, _input: Value) -> Result<Value, String> {
            let Some((expected_tool, value)) = self.responses.pop_front() else {
                return Err("missing mock response".to_string());
            };
            if expected_tool != tool {
                return Err(format!("unexpected tool call: {tool} != {expected_tool}"));
            }
            Ok(value)
        }
    }

    struct SlowBridge;

    impl ScriptToolBridge for SlowBridge {
        fn call(&mut self, _tool: &str, _input: Value) -> Result<Value, String> {
            thread::sleep(Duration::from_millis(10));
            Ok(json!({ "ok": true }))
        }
    }

    #[test]
    fn script_runtime_executes_knowledge_batch_analysis() {
        let request = ScriptExecutionRequest {
            runtime_mode: "knowledge".to_string(),
            program: ScriptProgram {
                version: SCRIPT_RUNTIME_PROGRAM_VERSION.to_string(),
                steps: vec![
                    ScriptStep::Tool {
                        id: Some("search".to_string()),
                        tool: "app.query".to_string(),
                        input: json!({
                            "operation": "knowledge.search",
                            "query": "agent"
                        }),
                        save_as: Some("search".to_string()),
                    },
                    ScriptStep::ForEach {
                        id: Some("loop".to_string()),
                        items: "search.results".to_string(),
                        item_as: Some("hit".to_string()),
                        max_items: Some(2),
                        steps: vec![
                            ScriptStep::Tool {
                                id: Some("read".to_string()),
                                tool: "fs.read".to_string(),
                                input: json!({
                                    "path": "{{hit.path}}"
                                }),
                                save_as: Some("doc".to_string()),
                            },
                            ScriptStep::StdoutWrite {
                                id: Some("emit".to_string()),
                                text: "## {{hit.title}}\n{{doc.content}}\n".to_string(),
                            },
                        ],
                    },
                    ScriptStep::ArtifactWrite {
                        id: Some("artifact".to_string()),
                        path: "knowledge/report.md".to_string(),
                        content: "{{stdout}}".to_string(),
                        save_as: Some("reportPath".to_string()),
                    },
                ],
            },
            ..ScriptExecutionRequest::default()
        };
        let limits = default_limits_for_runtime_mode("knowledge");
        let mut bridge = MockBridge::new(vec![
            (
                "app.query".to_string(),
                json!({
                    "results": [
                        { "title": "A", "path": "docs/a.md" },
                        { "title": "B", "path": "docs/b.md" }
                    ]
                }),
            ),
            ("fs.read".to_string(), json!({ "content": "alpha" })),
            ("fs.read".to_string(), json!({ "content": "beta" })),
        ]);

        let result = execute_script_with_bridge(&mut bridge, &request, limits).unwrap();

        assert!(result.success);
        assert!(result.stdout.contains("alpha"));
        assert!(result.stdout.contains("beta"));
        assert_eq!(result.tool_call_count, 3);
        assert_eq!(result.artifact_paths.len(), 1);
        assert!(result.estimated_prompt_reduction_chars > 0);
    }

    #[test]
    fn script_runtime_executes_diagnostics_report_flow() {
        let request = ScriptExecutionRequest {
            runtime_mode: "diagnostics".to_string(),
            program: ScriptProgram {
                version: SCRIPT_RUNTIME_PROGRAM_VERSION.to_string(),
                steps: vec![
                    ScriptStep::Tool {
                        id: Some("settings".to_string()),
                        tool: "app.query".to_string(),
                        input: json!({ "operation": "settings.summary" }),
                        save_as: Some("settings".to_string()),
                    },
                    ScriptStep::Tool {
                        id: Some("recall".to_string()),
                        tool: "memory.recall".to_string(),
                        input: json!({ "query": "workspace", "sources": ["memory"] }),
                        save_as: Some("recall".to_string()),
                    },
                    ScriptStep::StdoutWrite {
                        id: Some("emit".to_string()),
                        text: "model={{settings.modelName}}\nhits={{recall.totalHits}}\n"
                            .to_string(),
                    },
                    ScriptStep::ArtifactWrite {
                        id: Some("artifact".to_string()),
                        path: "diagnostics/runtime.txt".to_string(),
                        content: "{{stdout}}".to_string(),
                        save_as: None,
                    },
                ],
            },
            ..ScriptExecutionRequest::default()
        };
        let mut bridge = MockBridge::new(vec![
            ("app.query".to_string(), json!({ "modelName": "gpt-main" })),
            ("memory.recall".to_string(), json!({ "totalHits": 3 })),
        ]);

        let result = execute_script_with_bridge(
            &mut bridge,
            &request,
            default_limits_for_runtime_mode("diagnostics"),
        )
        .unwrap();

        assert!(result.success);
        assert!(result.stdout.contains("gpt-main"));
        assert!(result.stdout.contains("hits=3"));
        assert_eq!(result.tool_call_count, 2);
        assert_eq!(result.artifact_paths.len(), 1);
    }

    #[test]
    fn script_runtime_executes_video_editor_analysis_flow() {
        let request = ScriptExecutionRequest {
            runtime_mode: "video-editor".to_string(),
            program: ScriptProgram {
                version: SCRIPT_RUNTIME_PROGRAM_VERSION.to_string(),
                steps: vec![
                    ScriptStep::Tool {
                        id: Some("script".to_string()),
                        tool: "editor.script_read".to_string(),
                        input: json!({}),
                        save_as: Some("script".to_string()),
                    },
                    ScriptStep::Tool {
                        id: Some("project".to_string()),
                        tool: "editor.project_read".to_string(),
                        input: json!({}),
                        save_as: Some("project".to_string()),
                    },
                    ScriptStep::Tool {
                        id: Some("remotion".to_string()),
                        tool: "editor.remotion_read".to_string(),
                        input: json!({}),
                        save_as: Some("remotion".to_string()),
                    },
                    ScriptStep::StdoutWrite {
                        id: Some("emit".to_string()),
                        text: "script={{script.script.approval.status}}\nproject={{project.project.title}}\nrender={{remotion.state}}\n".to_string(),
                    },
                ],
            },
            ..ScriptExecutionRequest::default()
        };
        let mut bridge = MockBridge::new(vec![
            (
                "editor.script_read".to_string(),
                json!({ "script": { "approval": { "status": "confirmed" } } }),
            ),
            (
                "editor.project_read".to_string(),
                json!({ "project": { "title": "Demo" } }),
            ),
            (
                "editor.remotion_read".to_string(),
                json!({ "state": "ready" }),
            ),
        ]);

        let result = execute_script_with_bridge(
            &mut bridge,
            &request,
            default_limits_for_runtime_mode("video-editor"),
        )
        .unwrap();

        assert!(result.success);
        assert!(result.stdout.contains("confirmed"));
        assert!(result.stdout.contains("Demo"));
        assert!(result.stdout.contains("ready"));
        assert_eq!(result.tool_call_count, 3);
    }

    #[test]
    fn script_runtime_enforces_tool_call_budget() {
        let request = ScriptExecutionRequest {
            runtime_mode: "knowledge".to_string(),
            program: ScriptProgram {
                version: SCRIPT_RUNTIME_PROGRAM_VERSION.to_string(),
                steps: vec![
                    ScriptStep::Tool {
                        id: None,
                        tool: "app.query".to_string(),
                        input: json!({ "operation": "settings.summary" }),
                        save_as: None,
                    },
                    ScriptStep::Tool {
                        id: None,
                        tool: "app.query".to_string(),
                        input: json!({ "operation": "spaces.list" }),
                        save_as: None,
                    },
                ],
            },
            ..ScriptExecutionRequest::default()
        };
        let limits = merge_limits(
            default_limits_for_runtime_mode("knowledge"),
            Some(&ScriptExecutionLimitOverrides {
                max_tool_calls: Some(1),
                ..ScriptExecutionLimitOverrides::default()
            }),
        );
        let mut bridge = MockBridge::new(vec![
            ("app.query".to_string(), json!({ "modelName": "gpt-main" })),
            ("app.query".to_string(), json!({ "spaces": [] })),
        ]);

        let result = execute_script_with_bridge(&mut bridge, &request, limits).unwrap();

        assert!(!result.success);
        assert_eq!(
            result.error_summary.as_deref(),
            Some("script runtime exceeded maxToolCalls budget")
        );
    }

    #[test]
    fn script_runtime_enforces_timeout_budget() {
        let request = ScriptExecutionRequest {
            runtime_mode: "knowledge".to_string(),
            program: ScriptProgram {
                version: SCRIPT_RUNTIME_PROGRAM_VERSION.to_string(),
                steps: vec![
                    ScriptStep::Tool {
                        id: None,
                        tool: "app.query".to_string(),
                        input: json!({ "operation": "settings.summary" }),
                        save_as: None,
                    },
                    ScriptStep::Tool {
                        id: None,
                        tool: "app.query".to_string(),
                        input: json!({ "operation": "spaces.list" }),
                        save_as: None,
                    },
                ],
            },
            ..ScriptExecutionRequest::default()
        };
        let mut limits = default_limits_for_runtime_mode("knowledge");
        limits.timeout_ms = 1;
        let mut bridge = SlowBridge;

        let result = execute_script_with_bridge(&mut bridge, &request, limits).unwrap();

        assert!(!result.success);
        assert_eq!(
            result.error_summary.as_deref(),
            Some("script runtime timed out")
        );
    }
}
