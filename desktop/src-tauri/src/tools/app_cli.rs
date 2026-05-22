use base64::Engine;
use serde::Deserialize;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::mpsc::RecvTimeoutError;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, State};

use crate::commands;
use crate::events::{
    emit_runtime_task_checkpoint_saved, emit_runtime_tool_partial, emit_runtime_tool_request,
    emit_runtime_tool_result,
};
use crate::helpers::{
    compose_markdown_with_frontmatter, extract_markdown_frontmatter_block, normalize_relative_path,
    storage_safe_file_stem, strip_markdown_frontmatter,
};
use crate::interactive_runtime_shared::text_snippet;
use crate::persistence::{with_store, with_store_mut};
use crate::runtime::{
    clear_review_docket_waiters, register_review_docket_waiter,
    resolve_session_file_reference_inputs, McpServerRecord, SkillRecord,
};
use crate::skills::{
    find_catalog_skill_by_name, load_skill_bundle_sections_from_sources, resolve_skill_set,
    skill_allows_runtime_mode, LoadedSkillRecord,
};
use crate::tools::plan::build_tool_registry_plan_for_session;
use crate::tools::registry::normalized_allowed_app_cli_actions;
use crate::{
    guess_mime_and_kind, infer_protocol, join_relative, make_id, now_iso,
    parse_json_value_from_text, payload_field, payload_string, resolve_manuscript_path,
    workspace_root, AppState,
};

pub struct AppCliExecutor<'a> {
    app: &'a AppHandle,
    state: &'a State<'a, AppState>,
    runtime_mode: &'a str,
    session_id: Option<&'a str>,
    tool_call_id: Option<&'a str>,
}

const IMAGE_DIRECTOR_SKILL_NAME: &str = "image-director";
const MAX_IMAGE_BATCH_ITEMS: usize = 6;
const DEFAULT_VIDEO_ANALYSIS_MAX_BYTES: u64 = 64 * 1024 * 1024;

fn short_sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let digest = format!("{:x}", hasher.finalize());
    digest[..16].to_string()
}

fn video_analysis_cache_key(
    file_hash: &str,
    file_size: u64,
    mode: &str,
    model_name: &str,
    instruction: &str,
) -> String {
    let seed = format!(
        "{file_hash}\n{file_size}\n{}\n{}\n{}",
        mode.trim(),
        model_name.trim(),
        instruction.trim()
    );
    short_sha256_hex(seed.as_bytes())
}

fn read_video_analysis_cache(path: &Path) -> Option<Value> {
    let bytes = fs::read(path).ok()?;
    serde_json::from_slice::<Value>(&bytes).ok()
}

fn write_video_analysis_cache(path: &Path, value: &Value) {
    if let Some(parent) = path.parent() {
        if fs::create_dir_all(parent).is_err() {
            return;
        }
    }
    if let Ok(bytes) = serde_json::to_vec_pretty(value) {
        let _ = fs::write(path, bytes);
    }
}

fn channel_needs_runtime_context(channel: &str) -> bool {
    channel.starts_with("voice:")
        || channel.starts_with("media:")
        || channel.starts_with("generation:")
        || channel.starts_with("image-gen:")
        || channel.starts_with("video-gen:")
}

fn generation_agent_auto_execution_metadata(metadata: &Value) -> bool {
    payload_field(metadata, "contextType")
        .and_then(Value::as_str)
        .map(|value| value.trim() == "generation-agent")
        .unwrap_or(false)
        && payload_field(metadata, "executionMode")
            .and_then(Value::as_str)
            .map(|value| value.trim() == "auto")
            .unwrap_or(false)
        && !payload_field(metadata, "requiresHumanApproval")
            .and_then(Value::as_bool)
            .unwrap_or(false)
}

fn video_analysis_agent_system_prompt() -> &'static str {
    r#"你是应用内部专用 Video Analysis Agent。
你只负责根据提供的视频和用户指令输出结构化视频理解结果，不写最终发布文案，不冒充主聊天 agent。
如果用户目标是识别字幕、提取字幕、转录、SRT、VTT、ASR 或口播文字，主 agent 应调用 media.transcribe；这不是 Video Analysis Agent 的职责。
必须输出严格 JSON，字段包括：success, summary, transcript, scenes, highlights, editingSuggestions, warnings。
scenes 每项应尽量包含 startSec, endSec, title, description, visualNotes, speechNotes, importance。
highlights 每项应尽量包含 startSec, endSec, reason, suggestedUse。
如果无法确认时间戳、画面或声音，必须写入 warnings，不要编造。
如果指令要求剪口播、智能剪辑或精彩切片，只输出分析依据和剪辑建议，最终成稿由主 agent 完成。"#
}
#[derive(Debug, Clone, Default)]
struct CliArgs {
    positionals: Vec<String>,
    options: Map<String, Value>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct VideoStoryboardShot {
    time: String,
    picture: String,
    sound: String,
    shot: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct ImageGenerationPlanItem {
    title: String,
    prompt: String,
    copy: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ImageGenerationDeliveryMode {
    InlineWait,
    BackgroundFollowup,
    AsyncSubmit,
}

#[derive(Debug, Clone)]
struct BoundWritingSessionTarget {
    file_path: String,
    draft_type: String,
    title: Option<String>,
}

#[derive(Debug, Clone)]
struct CurrentAuthoringSessionTarget {
    project_path: String,
    project_kind: AuthoringProjectKind,
}

#[derive(Debug, Clone)]
struct AuthoringTargetPreference {
    preferred_kind: AuthoringProjectKind,
    preferred_subdir: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AuthoringProjectKind {
    Redpost,
    Redarticle,
}

fn normalize_authoring_target_subdir(
    requested_path: &str,
    preferred_subdir: Option<&str>,
) -> String {
    let normalized = normalize_relative_path(requested_path);
    let subdir = preferred_subdir
        .map(normalize_relative_path)
        .unwrap_or_default();
    if normalized.trim().is_empty() || subdir.trim().is_empty() {
        return normalized;
    }
    if normalized == subdir || normalized.starts_with(&(subdir.clone() + "/")) {
        return normalized;
    }
    format!("{}/{}", subdir.trim_end_matches('/'), normalized)
}

fn authoring_project_kind_from_value(value: Option<&str>) -> Option<AuthoringProjectKind> {
    match value.unwrap_or("").trim().to_ascii_lowercase().as_str() {
        "post" | "richpost" | "xiaohongshu" => Some(AuthoringProjectKind::Redpost),
        "article" | "longform" | "wechat" | "wechat_official_account" => {
            Some(AuthoringProjectKind::Redarticle)
        }
        _ => None,
    }
}

fn authoring_project_kind_from_target_path(path: &str) -> Option<AuthoringProjectKind> {
    let normalized = normalize_relative_path(path);
    let file_name = normalized.rsplit('/').next().unwrap_or_default();
    if file_name.contains('.') {
        return None;
    }
    Some(AuthoringProjectKind::Redpost)
}

fn authoring_project_kind_label(kind: AuthoringProjectKind) -> &'static str {
    match kind {
        AuthoringProjectKind::Redpost => "post",
        AuthoringProjectKind::Redarticle => "article",
    }
}

fn normalized_app_cli_action_key(value: &str) -> String {
    value
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .flat_map(|ch| ch.to_lowercase())
        .collect()
}

fn compat_metadata(arguments: &Value) -> Option<Value> {
    payload_field(arguments, "__compat")
        .cloned()
        .filter(|value| value.is_object())
}

fn normalized_structured_arguments(arguments: &Value) -> Value {
    let arguments = crate::normalized_structured_payload_arguments(arguments);
    let Some(action) = payload_string(&arguments, "action")
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    else {
        return arguments;
    };
    let mut normalized = arguments.as_object().cloned().unwrap_or_default();
    let mut payload = payload_field(&arguments, "payload")
        .cloned()
        .filter(|value| value.is_object())
        .unwrap_or_else(|| json!({}));
    let payload_object = payload
        .as_object_mut()
        .expect("normalized structured payload should always be an object");
    for (key, value) in normalized.iter() {
        if matches!(key.as_str(), "action" | "payload" | "command" | "__compat") {
            continue;
        }
        payload_object
            .entry(key.clone())
            .or_insert_with(|| value.clone());
    }
    normalized.insert("action".to_string(), json!(action));
    normalized.insert("payload".to_string(), payload);
    Value::Object(normalized)
}

fn action_success_envelope(action: &str, data: Value, compat: Option<Value>) -> Value {
    let mut object = serde_json::Map::new();
    object.insert("ok".to_string(), json!(true));
    object.insert("tool".to_string(), json!("workflow"));
    object.insert("action".to_string(), json!(action));
    object.insert("data".to_string(), data);
    if let Some(compat) = compat {
        object.insert("compat".to_string(), compat);
    }
    Value::Object(object)
}

fn is_bound_manuscript_write_call(arguments: &Value) -> bool {
    let compat = arguments.get("__compat").and_then(Value::as_object);
    let legacy_tool = compat
        .and_then(|object| object.get("legacyToolName"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    let legacy_command = compat
        .and_then(|object| object.get("legacyCommand"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    legacy_tool == "Write"
        && legacy_command
            .trim()
            .eq_ignore_ascii_case("manuscripts://current")
}

fn app_cli_error_json(
    action: Option<&str>,
    code: &str,
    message: &str,
    retryable: bool,
    details: Option<Value>,
) -> String {
    let mut object = serde_json::Map::new();
    object.insert("ok".to_string(), json!(false));
    object.insert("tool".to_string(), json!("workflow"));
    if let Some(action) = action.filter(|item| !item.trim().is_empty()) {
        object.insert("action".to_string(), json!(action));
    }
    let mut error = serde_json::Map::new();
    error.insert("code".to_string(), json!(code));
    error.insert("message".to_string(), json!(message));
    error.insert("retryable".to_string(), json!(retryable));
    if let Some(details) = details.filter(|value| !value.is_null()) {
        error.insert("details".to_string(), details);
    }
    object.insert("error".to_string(), Value::Object(error));
    serde_json::to_string_pretty(&Value::Object(object))
        .unwrap_or_else(|_| format!(r#"{{"ok":false,"error":{{"code":"{code}","message":"{message}","retryable":{retryable}}}}}"#))
}

fn app_cli_action_error(action: &str, message: &str) -> String {
    let parsed = serde_json::from_str::<Value>(message).ok();
    if parsed.as_ref().is_some_and(|value| {
        value.get("ok").and_then(Value::as_bool) == Some(false)
            && value.get("error").is_some_and(Value::is_object)
    }) {
        return message.to_string();
    }
    app_cli_error_json(Some(action), "ACTION_FAILED", message, false, None)
}

fn bool_payload_field(payload: &Value, key: &str) -> bool {
    payload.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn confirmed_team_plan(payload: &Value) -> bool {
    if bool_payload_field(payload, "userConfirmedTeamPlan") {
        return true;
    }
    payload
        .get("metadata")
        .map(|metadata| bool_payload_field(metadata, "userConfirmedTeamPlan"))
        .unwrap_or(false)
}

fn require_confirmed_team_plan(action: &str, payload: &Value) -> Result<(), String> {
    if confirmed_team_plan(payload) {
        return Ok(());
    }
    Err(app_cli_error_json(
        Some(action),
        "TEAM_PLAN_CONFIRMATION_REQUIRED",
        "创建 team 前必须先向用户列出团队成员和分工，并等待用户明确确认。确认后再调用本动作，并传入 userConfirmedTeamPlan=true。",
        false,
        Some(json!({
            "requiredBeforeAction": [
                "propose_team_members",
                "propose_division_of_work",
                "wait_for_explicit_user_confirmation"
            ],
            "confirmationField": "userConfirmedTeamPlan"
        })),
    ))
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct SkillHostSaveValidatorSet {
    applies_to: Vec<String>,
    rules: Vec<SkillHostSaveRule>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct SkillHostSaveRule {
    rule_type: String,
    message: String,
    values: Vec<String>,
    count: Option<usize>,
    case_insensitive: bool,
}

fn blank_line_run_at_least(content: &str, count: usize) -> bool {
    if count <= 1 {
        return content.contains('\n');
    }
    let normalized = content.replace("\r\n", "\n");
    let mut run = 0usize;
    for ch in normalized.chars() {
        if ch == '\n' {
            run += 1;
            if run >= count {
                return true;
            }
        } else {
            run = 0;
        }
    }
    false
}

fn content_has_line_equal_to_any(content: &str, values: &[String], case_insensitive: bool) -> bool {
    if values.is_empty() {
        return false;
    }
    content.lines().any(|line| {
        let trimmed = line.trim();
        values.iter().any(|value| {
            if case_insensitive {
                trimmed.eq_ignore_ascii_case(value.trim())
            } else {
                trimmed == value.trim()
            }
        })
    })
}

fn content_contains_any(content: &str, values: &[String], case_insensitive: bool) -> bool {
    if values.is_empty() {
        return false;
    }
    if case_insensitive {
        let normalized = content.to_ascii_lowercase();
        values
            .iter()
            .map(|value| value.to_ascii_lowercase())
            .any(|value| normalized.contains(&value))
    } else {
        values.iter().any(|value| content.contains(value))
    }
}

fn evaluate_skill_host_save_rule(rule: &SkillHostSaveRule, content: &str) -> bool {
    match rule.rule_type.trim().to_ascii_lowercase().as_str() {
        "lineequalsany" | "line_equals_any" | "line-equals-any" => {
            content_has_line_equal_to_any(content, &rule.values, rule.case_insensitive)
        }
        "containsany" | "contains_any" | "contains-any" => {
            content_contains_any(content, &rule.values, rule.case_insensitive)
        }
        "blanklinerunatleast" | "blank_line_run_at_least" | "blank-line-run-at-least" => {
            blank_line_run_at_least(content, rule.count.unwrap_or(3))
        }
        _ => false,
    }
}

fn build_authoring_project_relative_path(
    parent: Option<&str>,
    project_id: &str,
    _kind: AuthoringProjectKind,
) -> String {
    let normalized_parent = parent
        .map(normalize_relative_path)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_default();
    normalize_relative_path(&join_relative(&normalized_parent, project_id))
}

fn build_authoring_project_id(title: &str, _kind: AuthoringProjectKind) -> String {
    let stem = storage_safe_file_stem(title);
    format!("{stem}-{}", crate::now_ms())
}

impl CliArgs {
    fn string(&self, keys: &[&str]) -> Option<String> {
        keys.iter().find_map(|key| match self.options.get(*key) {
            Some(Value::String(text)) => Some(text.clone()),
            Some(Value::Number(value)) => Some(value.to_string()),
            Some(Value::Bool(value)) => Some(value.to_string()),
            _ => None,
        })
    }

    fn i64(&self, keys: &[&str]) -> Option<i64> {
        keys.iter().find_map(|key| match self.options.get(*key) {
            Some(Value::Number(value)) => value.as_i64(),
            Some(Value::String(text)) => text.trim().parse::<i64>().ok(),
            _ => None,
        })
    }

    fn bool(&self, keys: &[&str]) -> Option<bool> {
        keys.iter().find_map(|key| match self.options.get(*key) {
            Some(Value::Bool(value)) => Some(*value),
            Some(Value::Number(value)) => Some(value.as_i64().unwrap_or_default() != 0),
            Some(Value::String(text)) => match text.trim().to_ascii_lowercase().as_str() {
                "true" | "1" | "yes" | "on" => Some(true),
                "false" | "0" | "no" | "off" => Some(false),
                _ => None,
            },
            _ => None,
        })
    }

    fn value(&self, keys: &[&str]) -> Option<Value> {
        keys.iter().find_map(|key| self.options.get(*key).cloned())
    }
}

impl<'a> AppCliExecutor<'a> {
    pub fn new(
        app: &'a AppHandle,
        state: &'a State<'a, AppState>,
        runtime_mode: &'a str,
        session_id: Option<&'a str>,
        tool_call_id: Option<&'a str>,
    ) -> Self {
        Self {
            app,
            state,
            runtime_mode,
            session_id,
            tool_call_id,
        }
    }

    fn session_allowed_structured_actions(&self) -> Option<Vec<String>> {
        let session_id = self.session_id?;
        with_store(self.state, |store| {
            Ok(store
                .chat_sessions
                .iter()
                .find(|item| item.id == session_id)
                .and_then(|item| item.metadata.as_ref())
                .map(|metadata| normalized_allowed_app_cli_actions(Some(metadata)))
                .filter(|items| !items.is_empty()))
        })
        .ok()
        .flatten()
    }

    fn session_generation_agent_auto_execution_enabled(&self) -> bool {
        let Some(session_id) = self.session_id else {
            return false;
        };
        with_store(self.state, |store| {
            Ok(store
                .chat_sessions
                .iter()
                .find(|item| item.id == session_id)
                .and_then(|item| item.metadata.as_ref())
                .map(generation_agent_auto_execution_metadata)
                .unwrap_or(false))
        })
        .unwrap_or(false)
    }

    fn ensure_action_allowed(&self, action: &str, arguments: &Value) -> Result<(), String> {
        if action == "web.fetch" {
            return Ok(());
        }
        if action == "manuscripts.writeCurrent"
            && is_bound_manuscript_write_call(arguments)
            && self.current_authoring_session_target().is_some()
        {
            return Ok(());
        }
        let Some(allowed_actions) = self.session_allowed_structured_actions() else {
            let plan = with_store(self.state, |store| {
                Ok::<_, String>(build_tool_registry_plan_for_session(
                    &store,
                    self.runtime_mode,
                    self.session_id,
                ))
            })?;
            if plan.has_direct_app_cli_action(action) {
                return Ok(());
            }
            if let Some(deferred) = plan
                .deferred_app_cli_actions
                .iter()
                .find(|entry| entry.action == action)
            {
                return Err(app_cli_error_json(
                    Some(action),
                    "ACTION_DEFERRED",
                    "Operate action is available but not directly exposed in this turn; search actions first.",
                    true,
                    Some(json!({
                        "suggestedAction": "tool_search",
                        "queryHint": format!("{} {}", deferred.namespace, deferred.description),
                        "deferredNamespaces": plan.deferred_action_namespaces,
                    })),
                ));
            }
            return Err(app_cli_error_json(
                Some(action),
                "ACTION_NOT_AVAILABLE",
                "Operate action is not available in this runtime",
                false,
                Some(json!({
                    "runtimeMode": self.runtime_mode,
                    "directActions": plan
                        .direct_app_cli_actions
                        .iter()
                        .map(|descriptor| descriptor.action)
                        .collect::<Vec<_>>(),
                })),
            ));
        };
        if allowed_actions.iter().any(|item| item == action) {
            let plan = with_store(self.state, |store| {
                Ok::<_, String>(build_tool_registry_plan_for_session(
                    &store,
                    self.runtime_mode,
                    self.session_id,
                ))
            })?;
            if plan.has_direct_app_cli_action(action) {
                return Ok(());
            }
            return Err(app_cli_error_json(
                Some(action),
                "ACTION_NOT_AVAILABLE",
                "Operate action is not available in this runtime",
                false,
                Some(json!({
                    "runtimeMode": self.runtime_mode,
                    "allowedActions": allowed_actions,
                })),
            ));
        }
        Err(app_cli_error_json(
            Some(action),
            "ACTION_NOT_ALLOWED",
            "Operate action is not allowed in this session",
            false,
            Some(json!({
                "allowedActions": allowed_actions,
            })),
        ))
    }

    fn cli_runtime_scope_input(
        &self,
        args: &CliArgs,
        payload: &Value,
        fallback_name_keys: &[&str],
    ) -> Option<String> {
        let raw = args
            .string(&["scope"])
            .or_else(|| payload_string(payload, "scope"))
            .or_else(|| {
                fallback_name_keys
                    .iter()
                    .find_map(|key| payload_string(payload, key))
            })?;
        let normalized = raw.trim().to_ascii_lowercase();
        match normalized.as_str() {
            "app-global" | "app_global" | "global" | "npm-global" | "npm_global" => {
                Some("app-global".to_string())
            }
            "workspace-local" | "workspace_local" | "workspace" => {
                Some("workspace-local".to_string())
            }
            "task-ephemeral" | "task_ephemeral" | "task" | "ephemeral" => {
                Some("task-ephemeral".to_string())
            }
            _ if raw.trim().is_empty() => None,
            _ => Some(raw),
        }
    }

    pub fn execute(&self, arguments: &Value) -> Result<Value, String> {
        let normalized_arguments = normalized_structured_arguments(arguments);
        let payload = payload_field(&normalized_arguments, "payload")
            .cloned()
            .unwrap_or_else(|| json!({}));
        if let Some(action) = payload_string(&normalized_arguments, "action")
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
        {
            self.ensure_action_allowed(&action, &normalized_arguments)?;
            return self
                .execute_structured_action(&action, &payload)
                .map(|data| {
                    action_success_envelope(&action, data, compat_metadata(&normalized_arguments))
                });
        }
        if let Some(command) = payload_string(&normalized_arguments, "command")
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
        {
            return self.execute_legacy_command(&command, &payload).map(|data| {
                action_success_envelope(
                    "app_cli.command",
                    data,
                    compat_metadata(&normalized_arguments),
                )
            });
        }
        Err(app_cli_error_json(
            None,
            "ACTION_REQUIRED",
            "Operate requires a structured action",
            false,
            None,
        ))
    }

    fn execute_structured_action(&self, action: &str, payload: &Value) -> Result<Value, String> {
        let result = match normalized_app_cli_action_key(action).as_str() {
            "memorylist" => {
                let tokens = vec!["list".to_string()];
                self.handle_memory(&tokens, payload)
            }
            "webfetch" => self.handle_web(&["fetch".to_string()], payload),
            "sessionresourceslist" => self.handle_session_resources_list(payload),
            "sessionresourcesget" => self.handle_session_resources_get(payload),
            "videoanalyze" => self.handle_video_analyze(payload),
            "memorysearch" => {
                let tokens = vec!["search".to_string()];
                self.handle_memory(&tokens, payload)
            }
            "memoryrecall" => {
                let tokens = vec!["recall".to_string()];
                self.handle_memory(&tokens, payload)
            }
            "memoryadd" => {
                let tokens = vec!["add".to_string()];
                self.handle_memory(&tokens, payload)
            }
            "memoryupdate" => {
                let tokens = vec!["update".to_string()];
                self.handle_memory(&tokens, payload)
            }
            "memoryarchive" => {
                let tokens = vec!["archive".to_string()];
                self.handle_memory(&tokens, payload)
            }
            "memoryrebuildindex" => {
                let tokens = vec!["rebuild-index".to_string()];
                self.handle_memory(&tokens, payload)
            }
            "memorydiagnostics" => {
                let tokens = vec!["diagnostics".to_string()];
                self.handle_memory(&tokens, payload)
            }
            "redclawprofilebundle" => {
                let tokens = vec!["profile-bundle".to_string()];
                self.handle_redclaw(&tokens, payload)
            }
            "redclawprofileread" => {
                let tokens = vec!["profile-read".to_string()];
                self.handle_redclaw(&tokens, payload)
            }
            "redclawprofileupdate" => {
                let tokens = vec!["profile-update".to_string()];
                self.handle_redclaw(&tokens, payload)
            }
            "redclawprofilecompletestyledefinition" => {
                let tokens = vec!["profile-complete-style-definition".to_string()];
                self.handle_redclaw(&tokens, payload)
            }
            "redclawrunnerstatus" => {
                let tokens = vec!["runner-status".to_string()];
                self.handle_redclaw(&tokens, payload)
            }
            "redclawrunnerstart" => {
                let tokens = vec!["runner-start".to_string()];
                self.handle_redclaw(&tokens, payload)
            }
            "redclawrunnerstop" => {
                let tokens = vec!["runner-stop".to_string()];
                self.handle_redclaw(&tokens, payload)
            }
            "redclawrunnersetconfig" => {
                let tokens = vec!["runner-set-config".to_string()];
                self.handle_redclaw(&tokens, payload)
            }
            "redclawtaskpreview" => {
                let tokens = vec!["task-preview".to_string()];
                self.handle_redclaw(&tokens, payload)
            }
            "redclawtaskcreate" => {
                let tokens = vec!["task-create".to_string()];
                self.handle_redclaw(&tokens, payload)
            }
            "redclawtaskconfirm" => {
                let tokens = vec!["task-confirm".to_string()];
                self.handle_redclaw(&tokens, payload)
            }
            "redclawtaskupdate" => {
                let tokens = vec!["task-update".to_string()];
                self.handle_redclaw(&tokens, payload)
            }
            "redclawtaskcancel" => {
                let tokens = vec!["task-cancel".to_string()];
                self.handle_redclaw(&tokens, payload)
            }
            "redclawtasklist" => {
                let tokens = vec!["task-list".to_string()];
                self.handle_redclaw(&tokens, payload)
            }
            "redclawtaskstats" => {
                let tokens = vec!["task-stats".to_string()];
                self.handle_redclaw(&tokens, payload)
            }
            "manuscriptslist" => {
                let tokens = vec!["list".to_string()];
                self.handle_manuscripts(&tokens, payload)
            }
            "manuscriptsread" => {
                let path = payload_string(payload, "path")
                    .or_else(|| payload_string(payload, "filePath"))
                    .ok_or_else(|| "manuscripts.read requires payload.path".to_string())?;
                let tokens = vec!["read".to_string(), path];
                self.handle_manuscripts(&tokens, payload)
            }
            "manuscriptsreadcurrent" => self.handle_manuscript_read_current(),
            "manuscriptscreateproject" => {
                self.handle_manuscript_create_project(&CliArgs::default(), payload)
            }
            "manuscriptswritecurrent" => self.handle_manuscript_write_current(payload),
            "mediaedit" => {
                let tokens = vec!["edit".to_string()];
                self.handle_media(&tokens, payload)
            }
            "mediatranscribe" => {
                let tokens = vec!["transcribe".to_string()];
                self.handle_media(&tokens, payload)
            }
            "mediavideoretalk" => {
                let tokens = vec!["video-retalk".to_string()];
                self.handle_media(&tokens, payload)
            }
            "voiceclone" => {
                let tokens = vec!["clone".to_string()];
                self.handle_voice(&tokens, payload)
            }
            "voicebindasset" => {
                let tokens = vec!["bind-asset".to_string()];
                self.handle_voice(&tokens, payload)
            }
            "voicespeech" => {
                let tokens = vec!["speech".to_string()];
                self.handle_voice(&tokens, payload)
            }
            "voicelist" => {
                let tokens = vec!["list".to_string()];
                self.handle_voice(&tokens, payload)
            }
            "voiceget" => {
                let tokens = vec!["get".to_string()];
                self.handle_voice(&tokens, payload)
            }
            "voicedelete" => {
                let tokens = vec!["delete".to_string()];
                self.handle_voice(&tokens, payload)
            }
            "subjectssearch" => {
                let tokens = vec!["search".to_string()];
                self.handle_subjects(&tokens, payload)
            }
            "subjectsget" => {
                let tokens = vec!["get".to_string()];
                self.handle_subjects(&tokens, payload)
            }
            "subjectscreate" | "assetscreate" => {
                let resolved = self.asset_payload_with_resolved_category(payload)?;
                let tokens = vec!["create".to_string()];
                self.handle_subjects(&tokens, &resolved)
            }
            "subjectsupdate" | "assetsupdate" => {
                let resolved = self.asset_payload_with_resolved_category(payload)?;
                let tokens = vec!["update".to_string()];
                self.handle_subjects(&tokens, &resolved)
            }
            "subjectsdelete" | "assetsdelete" => {
                let tokens = vec!["delete".to_string()];
                self.handle_subjects(&tokens, payload)
            }
            "assetssearch" => {
                let tokens = vec!["search".to_string()];
                self.handle_subjects(&tokens, payload)
            }
            "assetsget" => {
                let tokens = vec!["get".to_string()];
                self.handle_subjects(&tokens, payload)
            }
            "assetscategorieslist" | "subjectscategorieslist" => {
                self.call_channel("subjects:categories:list", json!({}))
            }
            "assetscategoriescreate" | "subjectscategoriescreate" => {
                self.call_channel("subjects:categories:create", payload.clone())
            }
            "assetsgeneratecharactercard" | "subjectsgeneratecharactercard" => self.call_channel(
                "subjects:generate-character-card",
                json!({
                    "id": payload_string_alias(payload, &["id", "assetId", "subjectId"])
                        .ok_or_else(|| "assets.generateCharacterCard requires id".to_string())?
                }),
            ),
            "runtimequery" => {
                let tokens = vec!["query".to_string()];
                self.handle_runtime(&tokens, payload)
            }
            "runtimegetcheckpoints" => {
                let tokens = vec!["get-checkpoints".to_string()];
                self.handle_runtime(&tokens, payload)
            }
            "runtimegettoolresults" => {
                let tokens = vec!["get-tool-results".to_string()];
                self.handle_runtime(&tokens, payload)
            }
            "runtimetaskscreate" => {
                let tokens = vec!["tasks".to_string(), "create".to_string()];
                self.handle_runtime(&tokens, payload)
            }
            "runtimetaskslist" => {
                let tokens = vec!["tasks".to_string(), "list".to_string()];
                self.handle_runtime(&tokens, payload)
            }
            "runtimetasksget" => {
                let tokens = vec!["tasks".to_string(), "get".to_string()];
                self.handle_runtime(&tokens, payload)
            }
            "runtimetasksresume" => {
                let tokens = vec!["tasks".to_string(), "resume".to_string()];
                self.handle_runtime(&tokens, payload)
            }
            "runtimetaskscancel" => {
                let tokens = vec!["tasks".to_string(), "cancel".to_string()];
                self.handle_runtime(&tokens, payload)
            }
            "teamguidecreate" => {
                require_confirmed_team_plan("team.guide.create", payload)?;
                self.call_channel("team-runtime:guide-create", payload.clone())
            }
            "teamsessioncreate" => {
                let tokens = vec!["team".to_string(), "create-session".to_string()];
                self.handle_runtime(&tokens, payload)
            }
            "teamsessionlist" => {
                let tokens = vec!["team".to_string(), "list-sessions".to_string()];
                self.handle_runtime(&tokens, payload)
            }
            "teamsessionget" => {
                let tokens = vec!["team".to_string(), "get-session".to_string()];
                self.handle_runtime(&tokens, payload)
            }
            "teammemberslist" | "teammemberlist" => {
                let tokens = vec!["team".to_string(), "list-members".to_string()];
                self.handle_runtime(&tokens, payload)
            }
            "teammemberspawn" => {
                let tokens = vec!["team".to_string(), "add-member".to_string()];
                self.handle_runtime(&tokens, payload)
            }
            "teammembermatch" => self.call_channel(
                "team-runtime:execute-tool",
                json!({ "action": "team.member.match", "payload": payload }),
            ),
            "teammemberrename" => {
                let tokens = vec!["team".to_string(), "rename-member".to_string()];
                self.handle_runtime(&tokens, payload)
            }
            "teammembershutdown" => {
                let tokens = vec!["team".to_string(), "shutdown-member".to_string()];
                self.handle_runtime(&tokens, payload)
            }
            "teamtaskcreate" => {
                let tokens = vec!["team".to_string(), "create-task".to_string()];
                self.handle_runtime(&tokens, payload)
            }
            "teamtaskupdate" => {
                let tokens = vec!["team".to_string(), "update-task".to_string()];
                self.handle_runtime(&tokens, payload)
            }
            "teamtasklist" => {
                let tokens = vec!["team".to_string(), "list-tasks".to_string()];
                self.handle_runtime(&tokens, payload)
            }
            "teammessagesend" => {
                let tokens = vec!["team".to_string(), "send-message".to_string()];
                self.handle_runtime(&tokens, payload)
            }
            "teamreportrequest" => {
                let tokens = vec!["team".to_string(), "request-report".to_string()];
                self.handle_runtime(&tokens, payload)
            }
            "teamreportsubmit" => {
                let tokens = vec!["team".to_string(), "submit-report".to_string()];
                self.handle_runtime(&tokens, payload)
            }
            "teamreportlist" => {
                let tokens = vec!["team".to_string(), "list-reports".to_string()];
                self.handle_runtime(&tokens, payload)
            }
            "teamartifactattach" => self.call_channel(
                "team-runtime:execute-tool",
                json!({ "action": "team.artifact.attach", "payload": payload }),
            ),
            "approvalrequest" => self.handle_approval_request(payload),
            "cliruntimedetect" => {
                let tokens = vec!["detect".to_string()];
                self.handle_cli_runtime(&tokens, payload)
            }
            "cliruntimediscover" => {
                let tokens = vec!["discover".to_string()];
                self.handle_cli_runtime(&tokens, payload)
            }
            "cliruntimeinspect" => {
                let tokens = vec!["inspect".to_string()];
                self.handle_cli_runtime(&tokens, payload)
            }
            "cliruntimediagnose" => {
                let tokens = vec!["diagnose".to_string()];
                self.handle_cli_runtime(&tokens, payload)
            }
            "cliruntimeenvironmentlist" => {
                let tokens = vec!["environment".to_string(), "list".to_string()];
                self.handle_cli_runtime(&tokens, payload)
            }
            "cliruntimeenvironmentcreate" => {
                let tokens = vec!["environment".to_string(), "create".to_string()];
                self.handle_cli_runtime(&tokens, payload)
            }
            "cliruntimeinstall" => {
                let tokens = vec!["install".to_string()];
                self.handle_cli_runtime(&tokens, payload)
            }
            "cliruntimeexecute" => {
                let tokens = vec!["execute".to_string()];
                self.handle_cli_runtime(&tokens, payload)
            }
            "cliruntimeexecutionget" | "cliruntimegetexecution" => {
                let tokens = vec!["execution".to_string(), "get".to_string()];
                self.handle_cli_runtime(&tokens, payload)
            }
            "cliruntimeverify" => {
                let tokens = vec!["verify".to_string()];
                self.handle_cli_runtime(&tokens, payload)
            }
            "cliruntimeescalationapprove" => {
                let tokens = vec!["escalation".to_string(), "approve".to_string()];
                self.handle_cli_runtime(&tokens, payload)
            }
            "cliruntimeescalationdeny" => {
                let tokens = vec!["escalation".to_string(), "deny".to_string()];
                self.handle_cli_runtime(&tokens, payload)
            }
            "mcplist" => {
                let tokens = vec!["list".to_string()];
                self.handle_mcp(&tokens, payload)
            }
            "mcpadd" => {
                let tokens = vec!["add".to_string()];
                self.handle_mcp(&tokens, payload)
            }
            "mcpget" => {
                let tokens = vec!["get".to_string()];
                self.handle_mcp(&tokens, payload)
            }
            "mcpremove" | "mcpdelete" => {
                let tokens = vec!["remove".to_string()];
                self.handle_mcp(&tokens, payload)
            }
            "mcpenable" => {
                let tokens = vec!["enable".to_string()];
                self.handle_mcp(&tokens, payload)
            }
            "mcpdisable" => {
                let tokens = vec!["disable".to_string()];
                self.handle_mcp(&tokens, payload)
            }
            "mcpsessions" => {
                let tokens = vec!["sessions".to_string()];
                self.handle_mcp(&tokens, payload)
            }
            "mcpoauthstatus" => {
                let tokens = vec!["oauth-status".to_string()];
                self.handle_mcp(&tokens, payload)
            }
            "mcpsave" => {
                let tokens = vec!["save".to_string()];
                self.handle_mcp(&tokens, payload)
            }
            "mcptest" => {
                let tokens = vec!["test".to_string()];
                self.handle_mcp(&tokens, payload)
            }
            "mcpcall" => {
                let tokens = vec!["call".to_string()];
                self.handle_mcp(&tokens, payload)
            }
            "mcplisttools" => {
                let tokens = vec!["list-tools".to_string()];
                self.handle_mcp(&tokens, payload)
            }
            "mcplistresources" => {
                let tokens = vec!["list-resources".to_string()];
                self.handle_mcp(&tokens, payload)
            }
            "mcplistresourcetemplates" => {
                let tokens = vec!["list-resource-templates".to_string()];
                self.handle_mcp(&tokens, payload)
            }
            "mcpdisconnect" => {
                let tokens = vec!["disconnect".to_string()];
                self.handle_mcp(&tokens, payload)
            }
            "mcpdisconnectall" => {
                let tokens = vec!["disconnect-all".to_string()];
                self.handle_mcp(&tokens, payload)
            }
            "mcpdiscoverlocal" => {
                let tokens = vec!["discover-local".to_string()];
                self.handle_mcp(&tokens, payload)
            }
            "mcpimportlocal" => {
                let tokens = vec!["import-local".to_string()];
                self.handle_mcp(&tokens, payload)
            }
            "skillslist" => {
                let tokens = vec!["list".to_string()];
                self.handle_skills(&tokens, payload)
            }
            "skillsinvoke" => {
                let tokens = vec!["invoke".to_string()];
                self.handle_skills(&tokens, payload)
            }
            "skillsinstallfromrepo" | "skillsinstallfromgithub" => {
                let tokens = vec!["install-from-repo".to_string()];
                self.handle_skills(&tokens, payload)
            }
            "skillsuninstall" | "skillsdelete" => {
                let tokens = vec!["uninstall".to_string()];
                self.handle_skills(&tokens, payload)
            }
            "imagegenerate" => {
                let tokens = vec!["generate".to_string()];
                self.handle_image(&tokens, payload)
            }
            "videogenerate" => {
                let tokens = vec!["generate".to_string()];
                self.handle_video(&tokens, payload)
            }
            "videoprojectcreate" => {
                let args = CliArgs::default();
                self.handle_video_project_create(&args, payload)
            }
            other => {
                return Err(app_cli_error_json(
                    Some(action),
                    "UNSUPPORTED_ACTION",
                    &format!("unsupported structured Operate action: {other}"),
                    false,
                    None,
                ));
            }
        };
        result.map_err(|message| app_cli_action_error(action, &message))
    }

    fn execute_legacy_command(&self, command: &str, payload: &Value) -> Result<Value, String> {
        let tokens = tokenize_command(command);
        let Some(namespace) = tokens.first().map(String::as_str) else {
            return Ok(help_response(None));
        };
        let args = &tokens[1..];
        match namespace {
            "help" => Ok(help_response(tokens.get(1).map(String::as_str))),
            "advisors" => self.handle_advisors(args, payload),
            "chat" => self.handle_chat(args, payload),
            "spaces" => self.handle_spaces(args),
            "assets" => self.handle_subjects(args, payload),
            "subjects" => self.handle_subjects(args, payload),
            "manuscripts" => self.handle_manuscripts(args, payload),
            "media" => self.handle_media(args, payload),
            "voice" => self.handle_voice(args, payload),
            "image" => self.handle_image(args, payload),
            "video" => self.handle_video(args, payload),
            "knowledge" => self.handle_knowledge(args, payload),
            "work" => self.handle_work(args, payload),
            "memory" => self.handle_memory(args, payload),
            "web" => self.handle_web(args, payload),
            "redclaw" => self.handle_redclaw(args, payload),
            "runtime" => self.handle_runtime(args, payload),
            "approval" => {
                let action = args.first().map(String::as_str).unwrap_or("request");
                match action {
                    "request" => self.handle_approval_request(payload),
                    other => Err(format!("unsupported approval action: {other}")),
                }
            }
            "cli-runtime" | "cli_runtime" => self.handle_cli_runtime(args, payload),
            "settings" => self.handle_settings(args, payload),
            "skills" => self.handle_skills(args, payload),
            "session-resources" | "session_resources" => {
                self.handle_session_resources(args, payload)
            }
            "mcp" => self.handle_mcp(args, payload),
            "ai" => self.handle_ai(args, payload),
            other => Err(format!("unsupported app_cli command namespace: {other}")),
        }
    }

    fn handle_session_resources(
        &self,
        tokens: &[String],
        payload: &Value,
    ) -> Result<Value, String> {
        match tokens.first().map(String::as_str).unwrap_or("list") {
            "list" | "search" => self.handle_session_resources_list(payload),
            "get" => self.handle_session_resources_get(payload),
            other => Err(format!("unsupported session-resources action: {other}")),
        }
    }

    fn handle_session_resources_list(&self, payload: &Value) -> Result<Value, String> {
        let payload_session_id = payload_string(payload, "sessionId");
        let Some(session_id) = self.session_id.or(payload_session_id.as_deref()) else {
            return Err("session.resources.list requires an active session".to_string());
        };
        let include_child_sessions =
            payload_bool(payload, &["includeChildSessions"]).unwrap_or(true);
        let limit = payload_field(payload, "limit")
            .and_then(Value::as_u64)
            .map(|value| value.clamp(1, 100) as usize)
            .or(Some(20));
        let kind = payload_string(payload, "kind");
        let query = payload_string(payload, "query");
        with_store(self.state, |store| {
            Ok(crate::runtime::session_resources_value_for_session(
                &store,
                session_id,
                include_child_sessions,
                limit,
                kind.as_deref(),
                query.as_deref(),
            ))
        })
    }

    fn handle_session_resources_get(&self, payload: &Value) -> Result<Value, String> {
        let id = payload_string(payload, "id")
            .or_else(|| payload_string(payload, "reference"))
            .ok_or_else(|| "session.resources.get requires id or reference".to_string())?;
        let mut list_payload = json!({
            "limit": 100,
            "includeChildSessions": payload_bool(payload, &["includeChildSessions"]).unwrap_or(true),
        });
        if let Some(session_id) = payload_string(payload, "sessionId") {
            if let Some(object) = list_payload.as_object_mut() {
                object.insert("sessionId".to_string(), json!(session_id));
            }
        }
        let mut listed = self.handle_session_resources_list(&list_payload)?;
        let items = listed
            .get_mut("items")
            .and_then(Value::as_array_mut)
            .ok_or_else(|| "session.resources.get failed to load resource list".to_string())?;
        let found = items.iter().find(|item| {
            item.get("id").and_then(Value::as_str) == Some(id.as_str())
                || item.get("reference").and_then(Value::as_str) == Some(id.as_str())
                || item.get("path").and_then(Value::as_str) == Some(id.as_str())
        });
        found
            .cloned()
            .map(|resource| json!({ "success": true, "item": resource }))
            .ok_or_else(|| format!("session resource not found: {id}"))
    }

    fn handle_advisors(&self, tokens: &[String], payload: &Value) -> Result<Value, String> {
        let Some(action) = tokens.first().map(String::as_str) else {
            return Ok(help_response(Some("advisors")));
        };
        let args = parse_cli_args(&tokens[1..])?;
        match action {
            "list" => {
                let result = self.call_channel("advisors:list", json!({}))?;
                let mut advisors = result.as_array().cloned().unwrap_or_default();
                let limit = args
                    .i64(&["limit"])
                    .or_else(|| payload_field(payload, "limit").and_then(Value::as_i64))
                    .unwrap_or(20)
                    .clamp(1, 50) as usize;
                advisors.truncate(limit);
                Ok(json!({ "success": true, "advisors": advisors }))
            }
            "get" => {
                let advisor_id = args
                    .string(&["id", "advisor-id"])
                    .or_else(|| args.positionals.first().cloned())
                    .ok_or_else(|| "advisors get requires --id".to_string())?;
                let result = self.call_channel("advisors:list", json!({}))?;
                let advisor = result.as_array().and_then(|items| {
                    items.iter().find(|item| {
                        item.get("id")
                            .and_then(Value::as_str)
                            .map(|value| value == advisor_id)
                            .unwrap_or(false)
                    })
                });
                Ok(json!({ "success": advisor.is_some(), "advisor": advisor.cloned() }))
            }
            "list-templates" => self.call_channel("advisors:list-templates", json!({})),
            "create" => self.call_channel("advisors:create", merge_payload(&args.options, payload)),
            "update" => self.call_channel("advisors:update", merge_payload(&args.options, payload)),
            "delete" => self.call_channel(
                "advisors:delete",
                json!(args
                    .string(&["id", "advisor-id"])
                    .or_else(|| args.positionals.first().cloned())
                    .ok_or_else(|| "advisors delete requires --id".to_string())?),
            ),
            _ => Err(format!("unsupported advisors action: {action}")),
        }
    }

    fn handle_chat(&self, tokens: &[String], payload: &Value) -> Result<Value, String> {
        let Some(action) = tokens.first().map(String::as_str) else {
            return Ok(help_response(Some("chat")));
        };
        match action {
            "sessions" => {
                let sub = tokens.get(1).map(String::as_str).unwrap_or("list");
                let args = parse_cli_args(&tokens[2..])?;
                match sub {
                    "list" => {
                        let result = self.call_channel("chat:get-sessions", json!({}))?;
                        let mut sessions = result.as_array().cloned().unwrap_or_default();
                        let limit = args
                            .i64(&["limit"])
                            .or_else(|| payload_field(payload, "limit").and_then(Value::as_i64))
                            .unwrap_or(20)
                            .clamp(1, 50) as usize;
                        sessions.truncate(limit);
                        Ok(json!({ "success": true, "sessions": sessions }))
                    }
                    "get" => {
                        let session_id = args
                            .string(&["id", "session-id"])
                            .or_else(|| args.positionals.first().cloned())
                            .ok_or_else(|| "chat sessions get requires --id".to_string())?;
                        let result = self.call_channel("chat:get-sessions", json!({}))?;
                        let session = result.as_array().and_then(|items| {
                            items.iter().find(|item| {
                                item.get("id")
                                    .and_then(Value::as_str)
                                    .map(|value| value == session_id)
                                    .unwrap_or(false)
                            })
                        });
                        Ok(json!({ "success": session.is_some(), "session": session.cloned() }))
                    }
                    _ => Err(format!("unsupported chat sessions action: {sub}")),
                }
            }
            _ => Err(format!("unsupported chat action: {action}")),
        }
    }

    fn handle_spaces(&self, tokens: &[String]) -> Result<Value, String> {
        let Some(action) = tokens.first().map(String::as_str) else {
            return Ok(help_response(Some("spaces")));
        };
        let args = parse_cli_args(&tokens[1..])?;
        match action {
            "list" => self.call_channel("spaces:list", json!({})),
            "get" => {
                let id = args
                    .string(&["id", "space-id"])
                    .or_else(|| args.positionals.first().cloned())
                    .ok_or_else(|| "spaces get requires --id".to_string())?;
                let result = self.call_channel("spaces:list", json!({}))?;
                let space = result
                    .get("spaces")
                    .and_then(Value::as_array)
                    .and_then(|items| {
                        items.iter().find(|item| {
                            item.get("id")
                                .and_then(Value::as_str)
                                .map(|value| value == id)
                                .unwrap_or(false)
                        })
                    })
                    .cloned();
                Ok(json!({ "success": space.is_some(), "space": space }))
            }
            "create" => Ok(json!({
                "success": false,
                "error": commands::spaces::SPACE_CREATION_DISABLED_ERROR,
            })),
            "rename" => self.call_channel(
                "spaces:rename",
                json!({
                    "id": args
                        .string(&["id", "space-id"])
                        .or_else(|| args.positionals.first().cloned())
                        .ok_or_else(|| "spaces rename requires --id".to_string())?,
                    "name": args
                        .string(&["name"])
                        .or_else(|| args.positionals.get(1).cloned())
                        .ok_or_else(|| "spaces rename requires --name".to_string())?
                }),
            ),
            "delete" => self.call_channel(
                "spaces:delete",
                json!({
                    "id": args
                        .string(&["id", "space-id"])
                        .or_else(|| args.positionals.first().cloned())
                        .ok_or_else(|| "spaces delete requires --id".to_string())?
                }),
            ),
            "switch" => self.call_channel(
                "spaces:switch",
                json!({
                    "spaceId": args
                        .string(&["id", "space-id"])
                        .or_else(|| args.positionals.first().cloned())
                        .ok_or_else(|| "spaces switch requires --id".to_string())?
                }),
            ),
            _ => Err(format!("unsupported spaces action: {action}")),
        }
    }

    fn handle_subjects(&self, tokens: &[String], payload: &Value) -> Result<Value, String> {
        let Some(action) = tokens.first().map(String::as_str) else {
            return Ok(help_response(Some("subjects")));
        };
        if action == "categories" {
            return self.handle_subject_categories(&tokens[1..], payload);
        }
        let args = parse_cli_args(&tokens[1..])?;
        match action {
            "list" => self.call_channel("subjects:list", json!({})),
            "get" => self.call_channel(
                "subjects:get",
                json!({
                    "id": subject_id_from_args_or_payload(&args, payload)
                        .ok_or_else(|| "subjects get requires --id".to_string())?
                }),
            ),
            "search" => self.call_channel(
                "subjects:search",
                json!({
                    "query": subject_query_from_args_or_payload(&args, payload).unwrap_or_default(),
                    "categoryId": subject_category_from_args_or_payload(&args, payload)
                }),
            ),
            "create" => self.call_channel("subjects:create", merge_payload(&args.options, payload)),
            "update" => self.call_channel("subjects:update", merge_payload(&args.options, payload)),
            "delete" => self.call_channel(
                "subjects:delete",
                json!({
                    "id": args
                        .string(&["id"])
                        .or_else(|| payload_string_alias(payload, &["id", "assetId", "subjectId"]))
                        .or_else(|| args.positionals.first().cloned())
                        .ok_or_else(|| "subjects delete requires --id".to_string())?
                }),
            ),
            _ => Err(format!("unsupported subjects action: {action}")),
        }
    }

    fn asset_payload_with_resolved_category(&self, payload: &Value) -> Result<Value, String> {
        let mut map = payload.as_object().cloned().unwrap_or_default();
        if map
            .get("categoryId")
            .and_then(Value::as_str)
            .is_some_and(|value| !value.trim().is_empty())
        {
            return Ok(Value::Object(map));
        }
        let category_name = payload_string(payload, "categoryName")
            .or_else(|| {
                payload_string(payload, "kind")
                    .filter(|kind| kind.trim().eq_ignore_ascii_case("character"))
                    .map(|_| "角色".to_string())
            })
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        let Some(category_name) = category_name else {
            return Ok(Value::Object(map));
        };
        let categories_result = self.call_channel("subjects:categories:list", json!({}))?;
        let category_id = categories_result
            .get("categories")
            .and_then(Value::as_array)
            .and_then(|items| {
                items.iter().find_map(|item| {
                    let name = item.get("name").and_then(Value::as_str)?;
                    if name.trim().eq_ignore_ascii_case(&category_name) {
                        item.get("id")
                            .and_then(Value::as_str)
                            .map(ToString::to_string)
                    } else {
                        None
                    }
                })
            })
            .map(Ok)
            .unwrap_or_else(|| {
                let created = self.call_channel(
                    "subjects:categories:create",
                    json!({ "name": category_name }),
                )?;
                created
                    .pointer("/category/id")
                    .and_then(Value::as_str)
                    .map(ToString::to_string)
                    .ok_or_else(|| {
                        created
                            .get("error")
                            .and_then(Value::as_str)
                            .unwrap_or("资产分类创建失败")
                            .to_string()
                    })
            })?;
        map.insert("categoryId".to_string(), json!(category_id));
        Ok(Value::Object(map))
    }

    fn handle_subject_categories(
        &self,
        tokens: &[String],
        payload: &Value,
    ) -> Result<Value, String> {
        let Some(action) = tokens.first().map(String::as_str) else {
            return Ok(help_response(Some("subjects")));
        };
        let args = parse_cli_args(&tokens[1..])?;
        match action {
            "list" => self.call_channel("subjects:categories:list", json!({})),
            "create" => self.call_channel(
                "subjects:categories:create",
                merge_payload(&args.options, payload),
            ),
            "update" => self.call_channel(
                "subjects:categories:update",
                merge_payload(&args.options, payload),
            ),
            "delete" => self.call_channel(
                "subjects:categories:delete",
                json!({
                    "id": args
                        .string(&["id"])
                        .or_else(|| args.positionals.first().cloned())
                        .ok_or_else(|| "subjects categories delete requires --id".to_string())?
                }),
            ),
            _ => Err(format!("unsupported subjects categories action: {action}")),
        }
    }

    fn handle_manuscripts(&self, tokens: &[String], payload: &Value) -> Result<Value, String> {
        let Some(action) = tokens.first().map(String::as_str) else {
            return Ok(help_response(Some("manuscripts")));
        };
        if action == "layout" {
            return self.handle_manuscript_layout(&tokens[1..], payload);
        }
        let args = parse_cli_args(&tokens[1..])?;
        match action {
            "list" => self.call_channel("manuscripts:list", json!({})),
            "read" => self.call_channel(
                "manuscripts:read",
                json!(args
                    .string(&["path"])
                    .or_else(|| args.positionals.first().cloned())
                    .ok_or_else(|| "manuscripts read requires --path".to_string())?),
            ),
            "write-current" => {
                let mut merged = merge_payload(&args.options, payload);
                if let Some(object) = merged.as_object_mut() {
                    object
                        .entry("content".to_string())
                        .or_insert(json!(args.string(&["content"]).unwrap_or_default()));
                }
                self.handle_manuscript_write_current(&merged)
            }
            "write" | "save" => {
                let path = args
                    .string(&["path"])
                    .or_else(|| args.positionals.first().cloned())
                    .ok_or_else(|| "manuscripts write requires --path".to_string())?;
                let normalized_path = self.normalize_manuscript_target_path(&path);
                let mut merged = merge_payload(&args.options, payload);
                if let Some(object) = merged.as_object_mut() {
                    object.insert("path".to_string(), json!(normalized_path.clone()));
                    if !object.contains_key("content") {
                        object.insert(
                            "content".to_string(),
                            json!(args.string(&["content"]).unwrap_or_default()),
                        );
                    }
                }
                self.validate_authoring_save_content(
                    authoring_project_kind_from_target_path(&normalized_path),
                    &payload_string(&merged, "content").unwrap_or_default(),
                )?;
                let maybe_proposal = self.maybe_queue_writing_manuscript_proposal(
                    &normalized_path,
                    payload_string(&merged, "content").unwrap_or_default(),
                    payload_field(&merged, "metadata"),
                )?;
                if let Some(result) = maybe_proposal {
                    return Ok(result);
                }
                self.call_channel("manuscripts:save", merged)
            }
            "create" => {
                let relative = args
                    .string(&["path"])
                    .or_else(|| args.positionals.first().cloned())
                    .ok_or_else(|| "manuscripts create requires --path".to_string())?;
                let normalized = self.normalize_manuscript_target_path(&relative);
                let (parent_path, name) = split_parent_and_name(&normalized);
                self.call_channel(
                    "manuscripts:create-file",
                    json!({
                    "parentPath": parent_path,
                    "name": name,
                    "title": args.string(&["title"]),
                    "content": payload_string(payload, "content")
                        .or_else(|| args.string(&["content"]))
                        .unwrap_or_default(),
                    }),
                )
            }
            "create-project" => self.handle_manuscript_create_project(&args, payload),
            "delete" => self.call_channel(
                "manuscripts:delete",
                json!(args
                    .string(&["path"])
                    .or_else(|| args.positionals.first().cloned())
                    .ok_or_else(|| "manuscripts delete requires --path".to_string())?),
            ),
            _ => Err(format!("unsupported manuscripts action: {action}")),
        }
    }

    fn handle_manuscript_layout(
        &self,
        tokens: &[String],
        payload: &Value,
    ) -> Result<Value, String> {
        let Some(action) = tokens.first().map(String::as_str) else {
            return Ok(help_response(Some("manuscripts")));
        };
        match action {
            "get" => self.call_channel("manuscripts:get-layout", json!({})),
            "save" => self.call_channel("manuscripts:save-layout", payload.clone()),
            _ => Err(format!("unsupported manuscripts layout action: {action}")),
        }
    }

    fn handle_media(&self, tokens: &[String], payload: &Value) -> Result<Value, String> {
        let Some(action) = tokens.first().map(String::as_str) else {
            return Ok(help_response(Some("media")));
        };
        let args = parse_cli_args(&tokens[1..])?;
        match action {
            "list" => self.call_channel("media:list", json!({})),
            "get" => {
                let asset_id = args
                    .string(&["id", "asset-id"])
                    .or_else(|| args.positionals.first().cloned())
                    .ok_or_else(|| "media get requires --id".to_string())?;
                let result = self.call_channel("media:list", json!({}))?;
                let asset = result
                    .get("assets")
                    .and_then(Value::as_array)
                    .and_then(|items| {
                        items.iter().find(|item| {
                            item.get("id")
                                .and_then(Value::as_str)
                                .map(|value| value == asset_id)
                                .unwrap_or(false)
                        })
                    })
                    .cloned();
                Ok(json!({ "success": asset.is_some(), "asset": asset }))
            }
            "update" => self.call_channel("media:update", merge_payload(&args.options, payload)),
            "bind" => self.call_channel("media:bind", merge_payload(&args.options, payload)),
            "edit" => {
                let mut request = merge_payload(&args.options, payload);
                if let Some(object) = request.as_object_mut() {
                    if let Some(path) = args
                        .string(&["source-path", "sourcePath", "path", "tool-path", "toolPath"])
                        .or_else(|| args.positionals.first().cloned())
                    {
                        object.insert("sourcePath".to_string(), json!(path));
                    }
                    if let Some(summary) = args.string(&["intent-summary", "intentSummary"]) {
                        object.insert("intentSummary".to_string(), json!(summary));
                    }
                }
                commands::media_edit::execute_media_edit(
                    self.app,
                    self.state,
                    self.session_id,
                    &request,
                )
            }
            "transcribe" => {
                let mut request = merge_payload(&args.options, payload);
                if let Some(object) = request.as_object_mut() {
                    if let Some(path) = args
                        .string(&["source-path", "sourcePath", "path", "tool-path", "toolPath"])
                        .or_else(|| args.positionals.first().cloned())
                    {
                        object.insert("sourcePath".to_string(), json!(path));
                    }
                    if let Some(format) =
                        args.string(&["format", "response-format", "responseFormat"])
                    {
                        object.insert("format".to_string(), json!(format));
                    }
                    if let Some(language) = args.string(&["language", "lang"]) {
                        object.insert("language".to_string(), json!(language));
                    }
                }
                commands::media_transcribe::execute_media_transcribe(
                    self.app,
                    self.state,
                    self.session_id,
                    &request,
                )
            }
            "video-retalk" | "videoretalk" | "retalk" => {
                let mut request = merge_payload(&args.options, payload);
                if let Some(object) = request.as_object_mut() {
                    object.insert("model".to_string(), json!("videoretalk"));
                    object.insert("generationMode".to_string(), json!("video-retalk"));
                    object.entry("source".to_string()).or_insert(json!("tool"));
                    if let Some(video_url) = args.string(&["video-url", "videoUrl", "video_url"]) {
                        let input = object.entry("input".to_string()).or_insert(json!({}));
                        if let Some(input_object) = input.as_object_mut() {
                            input_object.insert("video_url".to_string(), json!(video_url));
                        }
                    }
                    if let Some(audio_url) = args.string(&["audio-url", "audioUrl", "audio_url"]) {
                        let input = object.entry("input".to_string()).or_insert(json!({}));
                        if let Some(input_object) = input.as_object_mut() {
                            input_object.insert("audio_url".to_string(), json!(audio_url));
                        }
                    }
                    if let Some(duration_seconds) =
                        args.string(&["duration-seconds", "durationSeconds", "duration_seconds"])
                    {
                        object.insert("durationSeconds".to_string(), json!(duration_seconds));
                    }
                    if let Some(resolution) = args.string(&["resolution"]) {
                        object.insert("resolution".to_string(), json!(resolution));
                    }
                    if let Some(video_extension) =
                        args.bool(&["video-extension", "videoExtension", "video_extension"])
                    {
                        object.insert("videoExtension".to_string(), json!(video_extension));
                    }
                    if let Some(session_id) = self.session_id {
                        object.insert("sessionId".to_string(), json!(session_id));
                    }
                    if let Some(tool_call_id) = self.tool_call_id {
                        object.insert("toolCallId".to_string(), json!(tool_call_id));
                        object.insert("toolName".to_string(), json!("workflow"));
                    }
                }
                let wait_for_completion = video_generation_should_wait(self.session_id, &request);
                if !wait_for_completion {
                    self.emit_tool_partial("VideoRetalk 任务已提交，后台会持续等待结果。");
                    let submitted = self.call_channel("generation:submit-video", request)?;
                    let follow_up = submitted
                        .get("jobId")
                        .and_then(Value::as_str)
                        .and_then(|job_id| {
                            self.session_id.map(|session_id| {
                                crate::media_runtime::spawn_media_job_followup_for_kind(
                                    self.app,
                                    self.runtime_mode,
                                    session_id,
                                    job_id,
                                    "video",
                                    1,
                                )
                            })
                        })
                        .transpose();
                    let mut result = submitted;
                    if let Some(object) = result.as_object_mut() {
                        match follow_up {
                            Ok(Some(follow_up)) => {
                                object.insert("followUp".to_string(), follow_up);
                            }
                            Ok(None) => {}
                            Err(error) => {
                                object.insert(
                                    "followUp".to_string(),
                                    json!({
                                        "success": false,
                                        "error": error,
                                    }),
                                );
                            }
                        }
                    }
                    return Ok(result);
                }
                self.emit_tool_partial("VideoRetalk 任务已提交，正在等待生成视频完成。");
                self.call_channel("video-gen:generate", request)
            }
            "delete" => self.call_channel(
                "media:delete",
                json!({
                    "assetId": args
                        .string(&["asset-id", "id"])
                        .or_else(|| args.positionals.first().cloned())
                        .ok_or_else(|| "media delete requires --asset-id".to_string())?
                }),
            ),
            _ => Err(format!("unsupported media action: {action}")),
        }
    }

    fn handle_voice(&self, tokens: &[String], payload: &Value) -> Result<Value, String> {
        let Some(action) = tokens.first().map(String::as_str) else {
            return Ok(help_response(Some("voice")));
        };
        let args = parse_cli_args(&tokens[1..])?;
        match action {
            "list" => self.call_channel("voice:list", merge_payload(&args.options, payload)),
            "get" => {
                let mut request = merge_payload(&args.options, payload);
                if let Some(voice_id) = args
                    .string(&["voice-id", "voiceId", "id"])
                    .or_else(|| args.positionals.first().cloned())
                {
                    if let Some(object) = request.as_object_mut() {
                        object.insert("voiceId".to_string(), json!(voice_id));
                    }
                }
                self.call_channel("voice:get", request)
            }
            "clone" => {
                let mut request = merge_payload(&args.options, payload);
                if let Some(object) = request.as_object_mut() {
                    if let Some(path) = args
                        .string(&["sample-path", "samplePath", "path", "file-path", "filePath"])
                        .or_else(|| args.positionals.first().cloned())
                    {
                        object.insert("samplePath".to_string(), json!(path));
                    }
                    if let Some(asset_id) =
                        args.string(&["owner-asset-id", "ownerAssetId", "asset-id", "assetId"])
                    {
                        object.insert("ownerAssetId".to_string(), json!(asset_id));
                    }
                    if let Some(sample_file_key) =
                        args.string(&["sample-file-key", "sampleFileKey", "sample_file_key"])
                    {
                        object.insert("sampleFileKey".to_string(), json!(sample_file_key));
                    }
                }
                self.call_channel("voice:clone", request)
            }
            "bind-asset" | "bind" => {
                let mut request = merge_payload(&args.options, payload);
                if let Some(object) = request.as_object_mut() {
                    if let Some(asset_id) =
                        args.string(&["owner-asset-id", "ownerAssetId", "asset-id", "assetId"])
                    {
                        object.insert("ownerAssetId".to_string(), json!(asset_id));
                    }
                    if let Some(voice_id) = args.string(&["voice-id", "voiceId", "voice"]) {
                        object.insert("voiceId".to_string(), json!(voice_id));
                    }
                }
                self.call_channel("voice:bind-asset", request)
            }
            "speech" | "tts" => {
                let mut request = merge_payload(&args.options, payload);
                if let Some(object) = request.as_object_mut() {
                    if let Some(input) = args.string(&["input", "text"]).or_else(|| {
                        if args.positionals.is_empty() {
                            None
                        } else {
                            Some(args.positionals.join(" "))
                        }
                    }) {
                        object.entry("input".to_string()).or_insert(json!(input));
                    }
                    if let Some(voice_id) = args.string(&["voice-id", "voiceId", "voice"]) {
                        object.insert("voiceId".to_string(), json!(voice_id));
                    }
                }
                self.call_channel("voice:speech", request)
            }
            "delete" => {
                let mut request = merge_payload(&args.options, payload);
                if let Some(voice_id) = args
                    .string(&["voice-id", "voiceId", "id"])
                    .or_else(|| args.positionals.first().cloned())
                {
                    if let Some(object) = request.as_object_mut() {
                        object.insert("voiceId".to_string(), json!(voice_id));
                    }
                }
                self.call_channel("voice:delete", request)
            }
            _ => Err(format!("unsupported voice action: {action}")),
        }
    }

    fn handle_image(&self, tokens: &[String], payload: &Value) -> Result<Value, String> {
        let Some(action) = tokens.first().map(String::as_str) else {
            return Ok(help_response(Some("image")));
        };
        let args = parse_cli_args(&tokens[1..])?;
        match action {
            "generate" => self.handle_image_generate(&args, payload),
            "history" => {
                let sub = tokens.get(1).map(String::as_str).unwrap_or("list");
                match sub {
                    "list" => self.generated_media_history("image"),
                    "get" => {
                        let nested_args = parse_cli_args(&tokens[2..])?;
                        let id = nested_args
                            .string(&["id", "asset-id"])
                            .or_else(|| nested_args.positionals.first().cloned())
                            .ok_or_else(|| "image history get requires --id".to_string())?;
                        self.generated_media_history_get("image", &id)
                    }
                    _ => Err(format!("unsupported image history action: {sub}")),
                }
            }
            "providers" | "models" => {
                let summary = self.call_channel("db:get-settings", json!({}))?;
                Ok(json!({
                    "imageProvider": summary.get("image_provider").cloned().unwrap_or(Value::Null),
                    "imageProviderTemplate": summary.get("image_provider_template").cloned().unwrap_or(Value::Null),
                    "imageModel": summary.get("image_model").cloned().unwrap_or(Value::Null),
                    "imageEndpoint": summary.get("image_endpoint").cloned().unwrap_or(Value::Null),
                    "hasImageApiKey": summary
                        .get("image_api_key")
                        .and_then(Value::as_str)
                        .map(|value| !value.trim().is_empty())
                        .unwrap_or(false),
                    "visualIndexEnabled": true,
                    "visualIndexProvider": summary.get("visual_index_provider").cloned().unwrap_or(Value::Null),
                    "visualIndexModel": summary.get("visual_index_model").cloned().unwrap_or(Value::Null),
                    "visualIndexEndpoint": summary.get("visual_index_endpoint").cloned().unwrap_or(Value::Null),
                    "hasVisualIndexApiKey": summary
                        .get("visual_index_api_key")
                        .and_then(Value::as_str)
                        .map(|value| !value.trim().is_empty())
                        .unwrap_or(false)
                }))
            }
            _ => Err(format!("unsupported image action: {action}")),
        }
    }

    fn handle_video(&self, tokens: &[String], payload: &Value) -> Result<Value, String> {
        let Some(action) = tokens.first().map(String::as_str) else {
            return Ok(help_response(Some("video")));
        };
        let args = parse_cli_args(&tokens[1..])?;
        match action {
            "analyze" => {
                let mut merged = payload.clone();
                if let Some(object) = merged.as_object_mut() {
                    if let Some(path) = args.string(&["path", "tool-path", "toolPath"]) {
                        object.insert("path".to_string(), json!(path));
                    }
                    if let Some(mode) = args.string(&["mode"]) {
                        object.insert("mode".to_string(), json!(mode));
                    }
                }
                self.handle_video_analyze(&merged)
            }
            "generate" => self.handle_video_generate(&args, payload),
            "project-create" => self.handle_video_project_create(&args, payload),
            "project-list" => self.handle_video_project_list(),
            "project-get" => self.handle_video_project_get(&args),
            "project-brief" => self.handle_video_project_brief(&args, payload),
            "project-script" => self.handle_video_project_script(&args, payload),
            "project-asset-add" => self.handle_video_project_asset_add(&args, payload),
            _ => Err(format!("unsupported video action: {action}")),
        }
    }

    fn resolve_video_analysis_path(&self, raw_path: &str) -> Result<PathBuf, String> {
        let normalized = raw_path.trim().replace('\\', "/");
        if normalized.is_empty() {
            return Err(app_cli_error_json(
                Some("video.analyze"),
                "FILE_UNAVAILABLE",
                "video.analyze requires payload.path or payload.toolPath",
                false,
                None,
            ));
        }
        let candidate = PathBuf::from(&normalized);
        let resolved = if candidate.is_absolute() {
            candidate
        } else {
            workspace_root(self.state)
                .map_err(|error| error.to_string())?
                .join(normalized)
        };
        if !resolved.is_file() {
            return Err(app_cli_error_json(
                Some("video.analyze"),
                "FILE_UNAVAILABLE",
                &format!("video file is not available: {}", resolved.display()),
                false,
                None,
            ));
        }
        Ok(resolved)
    }

    fn video_analysis_model_config(&self) -> Result<Value, String> {
        let settings = with_store(self.state, |store| Ok(store.settings.clone()))?;
        let resolved = crate::ai_model_manager::AiModelManager::resolve(
            &settings,
            crate::ai_model_manager::AiModelScope::VideoAnalysis,
            None,
        );
        let base_url = resolved
            .as_ref()
            .map(|route| route.base_url.clone())
            .filter(|value| !value.trim().is_empty())
            .or_else(|| payload_string(&settings, "video_analysis_endpoint"))
            .or_else(|| payload_string(&settings, "api_endpoint"))
            .unwrap_or_default();
        let model_name = resolved
            .as_ref()
            .map(|route| route.model_name.clone())
            .filter(|value| !value.trim().is_empty())
            .or_else(|| payload_string(&settings, "video_analysis_model"))
            .unwrap_or_default();
        if base_url.trim().is_empty() || model_name.trim().is_empty() {
            return Err(app_cli_error_json(
                Some("video.analyze"),
                "MISSING_VIDEO_MODEL",
                "Video Analysis Agent 缺少 endpoint 或模型名。",
                false,
                Some(json!({
                    "agentRole": "Video Analysis Agent",
                    "requiredSettings": ["video_analysis_endpoint", "video_analysis_model"]
                })),
            ));
        }
        let api_key = resolved
            .as_ref()
            .and_then(|route| route.api_key.clone())
            .or_else(|| payload_string(&settings, "video_analysis_api_key"))
            .or_else(|| payload_string(&settings, "api_key"));
        let protocol = resolved
            .as_ref()
            .map(|route| route.protocol.clone())
            .filter(|value| !value.trim().is_empty())
            .or_else(|| payload_string(&settings, "video_analysis_protocol"))
            .unwrap_or_else(|| infer_protocol(&base_url, None, None));
        Ok(json!({
            "protocol": protocol,
            "baseURL": base_url,
            "apiKey": api_key,
            "modelName": model_name,
            "maxBytes": settings
                .get("video_analysis_max_direct_video_bytes")
                .and_then(Value::as_u64)
                .unwrap_or(DEFAULT_VIDEO_ANALYSIS_MAX_BYTES),
        }))
    }

    fn handle_video_analyze(&self, payload: &Value) -> Result<Value, String> {
        let path = payload_string(payload, "toolPath")
            .or_else(|| payload_string(payload, "path"))
            .or_else(|| payload_string(payload, "workspaceRelativePath"))
            .ok_or_else(|| {
                app_cli_error_json(
                    Some("video.analyze"),
                    "FILE_UNAVAILABLE",
                    "video.analyze requires payload.path or payload.toolPath",
                    false,
                    None,
                )
            })?;
        let video_path = self.resolve_video_analysis_path(&path)?;
        let metadata = fs::metadata(&video_path).map_err(|error| {
            app_cli_error_json(
                Some("video.analyze"),
                "FILE_UNAVAILABLE",
                &error.to_string(),
                false,
                None,
            )
        })?;
        let model_config = self.video_analysis_model_config()?;
        let max_bytes = model_config
            .get("maxBytes")
            .and_then(Value::as_u64)
            .unwrap_or(DEFAULT_VIDEO_ANALYSIS_MAX_BYTES);
        if metadata.len() == 0 || metadata.len() > max_bytes {
            return Err(app_cli_error_json(
                Some("video.analyze"),
                "FILE_TOO_LARGE",
                &format!(
                    "视频文件大小为 {} bytes，超过 Video Analysis Agent 直传上限 {} bytes。",
                    metadata.len(),
                    max_bytes
                ),
                false,
                Some(json!({ "size": metadata.len(), "maxBytes": max_bytes })),
            ));
        }
        let (_guessed_mime, kind, _) = guess_mime_and_kind(&video_path);
        if kind != "video" {
            return Err(app_cli_error_json(
                Some("video.analyze"),
                "UNSUPPORTED_MEDIA",
                "video.analyze 只接受视频文件。",
                false,
                Some(json!({ "kind": kind, "path": video_path.display().to_string() })),
            ));
        }
        let mime_type = payload_string(payload, "mimeType")
            .unwrap_or_else(|| "video/*".to_string())
            .replace("video/*", "video/mp4");
        let bytes = fs::read(&video_path).map_err(|error| {
            app_cli_error_json(
                Some("video.analyze"),
                "FILE_UNAVAILABLE",
                &error.to_string(),
                false,
                None,
            )
        })?;
        let mode = payload_string(payload, "mode").unwrap_or_else(|| "summary".to_string());
        let instruction = payload_string(payload, "instruction").unwrap_or_default();
        let attachment_id = payload_string(payload, "attachmentId");
        let protocol = model_config
            .get("protocol")
            .and_then(Value::as_str)
            .unwrap_or("openai");
        let base_url = model_config
            .get("baseURL")
            .and_then(Value::as_str)
            .unwrap_or("");
        let api_key = model_config.get("apiKey").and_then(Value::as_str);
        let model_name = model_config
            .get("modelName")
            .and_then(Value::as_str)
            .unwrap_or("");
        let file_hash = short_sha256_hex(&bytes);
        let cache_key =
            video_analysis_cache_key(&file_hash, metadata.len(), &mode, model_name, &instruction);
        let cache_path = workspace_root(self.state)
            .map_err(|error| error.to_string())?
            .join(".redbox")
            .join("video-analysis-cache")
            .join(format!("{cache_key}.json"));
        if let Some(mut cached) = read_video_analysis_cache(&cache_path) {
            if let Some(object) = cached.as_object_mut() {
                object.insert("cacheHit".to_string(), json!(true));
                object.insert(
                    "cachePath".to_string(),
                    json!(cache_path.display().to_string()),
                );
            }
            return Ok(cached);
        }
        let base64_data = base64::engine::general_purpose::STANDARD.encode(bytes);
        let system_prompt = video_analysis_agent_system_prompt();
        let user_prompt = format!(
            "请作为 Video Analysis Agent 分析这个视频。\n\nanalysisMode: {}\nattachmentId: {}\nvideoPath: {}\ninstruction: {}\n\n只输出 JSON。",
            mode.trim(),
            attachment_id.as_deref().unwrap_or(""),
            video_path.display(),
            instruction.trim()
        );
        let raw = crate::official_support::invoke_video_analysis_by_protocol(
            protocol,
            base_url,
            api_key,
            model_name,
            system_prompt,
            &user_prompt,
            &mime_type,
            &base64_data,
        )
        .map_err(|error| {
            app_cli_error_json(
                Some("video.analyze"),
                "PROVIDER_ERROR",
                &error,
                true,
                Some(json!({
                    "agentRole": "Video Analysis Agent",
                    "modelName": model_name,
                    "protocol": protocol
                })),
            )
        })?;
        let parsed = parse_json_value_from_text(&raw).unwrap_or_else(|| {
            json!({
                "success": true,
                "summary": raw,
                "scenes": [],
                "highlights": [],
                "editingSuggestions": [],
                "warnings": ["Video Analysis Agent returned non-JSON text; wrapped as summary."]
            })
        });
        let output = json!({
            "analysisId": make_id("video-analysis"),
            "cacheHit": false,
            "cacheKey": cache_key,
            "cachePath": cache_path.display().to_string(),
            "agentRole": "Video Analysis Agent",
            "modelName": model_name,
            "source": {
                "attachmentId": attachment_id,
                "path": video_path.display().to_string(),
                "mimeType": mime_type,
                "size": metadata.len(),
                "fileHash": file_hash
            },
            "mode": mode,
            "result": parsed,
            "createdAt": now_iso(),
        });
        write_video_analysis_cache(&cache_path, &output);
        Ok(output)
    }

    fn handle_knowledge(&self, tokens: &[String], payload: &Value) -> Result<Value, String> {
        let Some(action) = tokens.first().map(String::as_str) else {
            return Ok(help_response(Some("knowledge")));
        };
        let args = parse_cli_args(&tokens[1..])?;
        match action {
            "list" => Ok(json!({
                "notes": self.call_channel("knowledge:list", json!({}))?,
                "youtube": self.call_channel("knowledge:list-youtube", json!({}))?,
                "documentSources": self.call_channel("knowledge:docs:list", json!({}))?
            })),
            "search" => self.call_channel(
                "knowledge:list",
                json!({}),
            )
            .and_then(|_| {
                let query = args
                    .string(&["query", "q"])
                    .or_else(|| payload_string(payload, "query"))
                    .or_else(|| {
                        if args.positionals.is_empty() {
                            None
                        } else {
                            Some(args.positionals.join(" "))
                        }
                    })
                    .unwrap_or_default()
                    .to_lowercase();
                let limit = args
                    .i64(&["limit"])
                    .or_else(|| payload_field(payload, "limit").and_then(Value::as_i64))
                    .unwrap_or(8)
                    .clamp(1, 20) as usize;
                with_store(self.state, |store| {
                    let mut hits = Vec::<Value>::new();
                    for note in &store.knowledge_notes {
                        let haystack = format!(
                            "{}\n{}\n{}",
                            note.title,
                            note.content,
                            note.transcript.clone().unwrap_or_default()
                        )
                        .to_lowercase();
                        if haystack.contains(&query) {
                            hits.push(json!({
                                "kind": "note",
                                "id": note.id,
                                "title": note.title,
                                "snippet": text_snippet(&note.content, 220),
                                "sourceUrl": note.source_url,
                            }));
                        }
                    }
                    for video in &store.youtube_videos {
                        let haystack = format!(
                            "{}\n{}\n{}\n{}",
                            video.title,
                            video.description,
                            video.summary.clone().unwrap_or_default(),
                            video.subtitle_content.clone().unwrap_or_default()
                        )
                        .to_lowercase();
                        if haystack.contains(&query) {
                            hits.push(json!({
                                "kind": "youtube",
                                "id": video.id,
                                "title": video.title,
                                "snippet": text_snippet(
                                    &video.summary.clone().unwrap_or_else(|| video.description.clone()),
                                    220
                                ),
                                "videoUrl": video.video_url,
                            }));
                        }
                    }
                    Ok(json!({
                        "success": true,
                        "results": hits.into_iter().take(limit).collect::<Vec<_>>()
                    }))
                })
            }),
            _ => Err(format!("unsupported knowledge action: {action}")),
        }
    }

    fn handle_work(&self, tokens: &[String], payload: &Value) -> Result<Value, String> {
        let Some(action) = tokens.first().map(String::as_str) else {
            return Ok(help_response(Some("work")));
        };
        let args = parse_cli_args(&tokens[1..])?;
        match action {
            "list" => {
                let result = self.call_channel("work:list", json!({}))?;
                let mut items = result.as_array().cloned().unwrap_or_default();
                let status = args
                    .string(&["status"])
                    .or_else(|| payload_string(payload, "status"));
                if let Some(status) = status.filter(|value| !value.trim().is_empty()) {
                    items.retain(|item| {
                        item.get("status")
                            .and_then(Value::as_str)
                            .map(|value| value == status)
                            .unwrap_or(false)
                    });
                }
                let limit = args
                    .i64(&["limit"])
                    .or_else(|| payload_field(payload, "limit").and_then(Value::as_i64))
                    .unwrap_or(20)
                    .clamp(1, 50) as usize;
                items.truncate(limit);
                Ok(json!({ "success": true, "workItems": items }))
            }
            "ready" => self.call_channel("work:ready", json!({})),
            "get" => self.call_channel(
                "work:get",
                json!({
                    "id": args
                        .string(&["id"])
                        .or_else(|| args.positionals.first().cloned())
                        .ok_or_else(|| "work get requires --id".to_string())?
                }),
            ),
            "update" => self.call_channel("work:update", merge_payload(&args.options, payload)),
            _ => Err(format!("unsupported work action: {action}")),
        }
    }

    fn handle_memory(&self, tokens: &[String], payload: &Value) -> Result<Value, String> {
        let Some(action) = tokens.first().map(String::as_str) else {
            return Ok(help_response(Some("memory")));
        };
        let args = parse_cli_args(&tokens[1..])?;
        let (channel, request_payload) = memory_action_request(action, &args, payload)?;
        self.call_channel(channel, request_payload)
    }

    fn handle_web(&self, tokens: &[String], payload: &Value) -> Result<Value, String> {
        let action = tokens.first().map(String::as_str).unwrap_or("fetch");
        match action {
            "fetch" | "get" | "read" => crate::tools::web_access::fetch(payload),
            "search" => Err(
                "web search is not available; provide a URL and use Read(path=\"https://...\")"
                    .to_string(),
            ),
            other => Err(format!("unsupported web action: {other}")),
        }
    }

    fn handle_redclaw(&self, tokens: &[String], payload: &Value) -> Result<Value, String> {
        let Some(action) = tokens.first().map(String::as_str) else {
            return Ok(help_response(Some("redclaw")));
        };
        let args = parse_cli_args(&tokens[1..])?;
        match action {
            "list-projects" | "projects" => {
                Ok(json!({ "success": true, "projects": [], "deprecated": true }))
            }
            "runner-status" => self.call_channel("redclaw:runner-status", json!({})),
            "runner-run-now" => self.call_channel("redclaw:runner-run-now", json!({})),
            "runner-start" => self.call_channel(
                "redclaw:runner-start",
                merge_payload(&args.options, payload),
            ),
            "runner-stop" => self.call_channel("redclaw:runner-stop", json!({})),
            "runner-set-config" => self.call_channel(
                "redclaw:runner-set-config",
                merge_payload(&args.options, payload),
            ),
            "task-preview" => self.call_channel(
                "redclaw:task-preview",
                if payload.is_object() {
                    payload.clone()
                } else {
                    merge_payload(&args.options, payload)
                },
            ),
            "task-create" => self.call_channel(
                "redclaw:task-create",
                if payload.is_object() {
                    payload.clone()
                } else {
                    merge_payload(&args.options, payload)
                },
            ),
            "task-confirm" => self.call_channel(
                "redclaw:task-confirm",
                json!({
                    "draftId": args
                        .string(&["draft-id", "draftId"])
                        .or_else(|| payload_string(payload, "draftId"))
                        .ok_or_else(|| "redclaw task-confirm requires --draft-id".to_string())?,
                    "confirm": args
                        .string(&["confirm"])
                        .and_then(|value| value.parse::<bool>().ok())
                        .or_else(|| payload_field(payload, "confirm").and_then(Value::as_bool))
                        .unwrap_or(true),
                }),
            ),
            "task-update" => self.call_channel(
                "redclaw:task-update",
                json!({
                    "jobDefinitionId": args
                        .string(&["job-definition-id", "jobDefinitionId"])
                        .or_else(|| payload_string(payload, "jobDefinitionId"))
                        .ok_or_else(|| "redclaw task-update requires --job-definition-id".to_string())?,
                    "reason": args
                        .string(&["reason"])
                        .or_else(|| payload_string(payload, "reason"))
                        .ok_or_else(|| "redclaw task-update requires --reason".to_string())?,
                    "patch": payload_field(payload, "patch").cloned().unwrap_or_else(|| json!({})),
                }),
            ),
            "task-cancel" => self.call_channel(
                "redclaw:task-cancel",
                json!({
                    "jobDefinitionId": args
                        .string(&["job-definition-id", "jobDefinitionId"])
                        .or_else(|| args.string(&["draft-id", "draftId"]))
                        .or_else(|| payload_string(payload, "jobDefinitionId"))
                        .or_else(|| payload_string(payload, "draftId"))
                        .ok_or_else(|| "redclaw task-cancel requires --job-definition-id".to_string())?,
                    "reason": args
                        .string(&["reason"])
                        .or_else(|| payload_string(payload, "reason")),
                }),
            ),
            "task-list" => self.call_channel(
                "redclaw:task-list",
                json!({
                    "ownerScope": args
                        .string(&["owner-scope", "ownerScope"])
                        .or_else(|| payload_string(payload, "ownerScope")),
                    "includeDrafts": args
                        .string(&["include-drafts", "includeDrafts"])
                        .and_then(|value| value.parse::<bool>().ok())
                        .or_else(|| payload_field(payload, "includeDrafts").and_then(Value::as_bool))
                        .unwrap_or(true),
                }),
            ),
            "task-stats" => self.call_channel("redclaw:task-stats", json!({})),
            "profile-bundle" => self.call_channel("redclaw:profile:get-bundle", json!({})),
            "profile-read" => {
                let doc_type = args
                    .string(&["doc-type", "type"])
                    .or_else(|| args.positionals.first().cloned())
                    .unwrap_or_else(|| "user".to_string());
                let bundle = self.call_channel("redclaw:profile:get-bundle", json!({}))?;
                let content = match doc_type.as_str() {
                    "agent" => bundle
                        .pointer("/files/agent")
                        .cloned()
                        .unwrap_or(Value::Null),
                    "soul" => bundle
                        .pointer("/files/soul")
                        .cloned()
                        .unwrap_or(Value::Null),
                    "identity" => bundle
                        .pointer("/files/identity")
                        .cloned()
                        .unwrap_or(Value::Null),
                    "user" => bundle
                        .pointer("/files/user")
                        .cloned()
                        .unwrap_or(Value::Null),
                    "creator_profile" | "creator-profile" => bundle
                        .pointer("/files/creatorProfile")
                        .cloned()
                        .unwrap_or(Value::Null),
                    _ => Value::Null,
                };
                Ok(json!({
                    "success": !content.is_null(),
                    "docType": doc_type,
                    "content": content
                }))
            }
            "profile-update" => self.call_channel(
                "redclaw:profile:update-doc",
                json!({
                    "docType": args
                        .string(&["doc-type", "type"])
                        .or_else(|| args.positionals.first().cloned())
                        .ok_or_else(|| "redclaw profile-update requires --doc-type".to_string())?,
                    "markdown": payload_string(payload, "markdown")
                        .or_else(|| args.string(&["markdown"]))
                        .unwrap_or_default(),
                    "reason": args.string(&["reason"])
                }),
            ),
            "profile-complete-style-definition" => {
                self.call_channel("redclaw:profile:complete-style-definition", payload.clone())
            }
            "profile-onboarding" => {
                let bundle = self.call_channel("redclaw:profile:get-bundle", json!({}))?;
                let onboarding = bundle
                    .get("onboardingState")
                    .cloned()
                    .unwrap_or(Value::Null);
                Ok(json!({
                    "success": !onboarding.is_null(),
                    "completed": onboarding
                        .get("completedAt")
                        .and_then(Value::as_str)
                        .map(|value| !value.trim().is_empty())
                        .unwrap_or(false),
                    "state": onboarding
                }))
            }
            _ => Err(format!("unsupported redclaw action: {action}")),
        }
    }

    fn handle_runtime(&self, tokens: &[String], payload: &Value) -> Result<Value, String> {
        let Some(action) = tokens.first().map(String::as_str) else {
            return Ok(help_response(Some("runtime")));
        };
        let args = parse_cli_args(&tokens[1..])?;
        match action {
            "query" => self.call_channel(
                "runtime:query",
                json!({
                    "sessionId": args
                        .string(&["session-id", "sessionId"])
                        .or_else(|| payload_string(payload, "sessionId")),
                    "message": args
                        .string(&["message"])
                        .or_else(|| payload_string(payload, "message"))
                        .unwrap_or_default(),
                    "modelConfig": payload_field(payload, "modelConfig").cloned().unwrap_or(Value::Null),
                }),
            ),
            "resume" => self.call_channel(
                "runtime:resume",
                json!({
                    "sessionId": args
                        .string(&["session-id", "sessionId"])
                        .or_else(|| payload_string(payload, "sessionId"))
                        .unwrap_or_default()
                }),
            ),
            "fork-session" => self.call_channel(
                "runtime:fork-session",
                json!({
                    "sessionId": args
                        .string(&["session-id", "sessionId"])
                        .or_else(|| payload_string(payload, "sessionId"))
                        .unwrap_or_default()
                }),
            ),
            "get-trace" => self.call_channel(
                "runtime:get-trace",
                json!({
                    "sessionId": args
                        .string(&["session-id", "sessionId"])
                        .or_else(|| payload_string(payload, "sessionId"))
                        .unwrap_or_default(),
                    "limit": args
                        .i64(&["limit"])
                        .or_else(|| payload_field(payload, "limit").and_then(Value::as_i64))
                        .unwrap_or(50)
                }),
            ),
            "get-checkpoints" => self.call_channel(
                "runtime:get-checkpoints",
                json!({
                    "sessionId": args
                        .string(&["session-id", "sessionId"])
                        .or_else(|| payload_string(payload, "sessionId"))
                        .unwrap_or_default(),
                    "limit": args
                        .i64(&["limit"])
                        .or_else(|| payload_field(payload, "limit").and_then(Value::as_i64))
                        .unwrap_or(50)
                }),
            ),
            "get-tool-results" => self.call_channel(
                "runtime:get-tool-results",
                json!({
                    "sessionId": args
                        .string(&["session-id", "sessionId"])
                        .or_else(|| payload_string(payload, "sessionId"))
                        .unwrap_or_default(),
                    "limit": args
                        .i64(&["limit"])
                        .or_else(|| payload_field(payload, "limit").and_then(Value::as_i64))
                        .unwrap_or(50)
                }),
            ),
            "tasks" => {
                let sub = tokens.get(1).map(String::as_str).unwrap_or("list");
                let nested_args = parse_cli_args(&tokens[2..])?;
                match sub {
                    "create" => self.call_channel(
                        "tasks:create",
                        payload_field(payload, "payload")
                            .cloned()
                            .unwrap_or_else(|| merge_payload(&nested_args.options, payload)),
                    ),
                    "list" => self.call_channel("tasks:list", json!({})),
                    "get" => self.call_channel(
                        "tasks:get",
                        json!({
                            "taskId": nested_args
                                .string(&["task-id", "taskId"])
                                .or_else(|| payload_string(payload, "taskId"))
                                .ok_or_else(|| "runtime tasks get requires --task-id".to_string())?
                        }),
                    ),
                    "resume" => self.call_channel(
                        "tasks:resume",
                        json!({
                            "taskId": nested_args
                                .string(&["task-id", "taskId"])
                                .or_else(|| payload_string(payload, "taskId"))
                                .ok_or_else(|| "runtime tasks resume requires --task-id".to_string())?
                        }),
                    ),
                    "cancel" => self.call_channel(
                        "tasks:cancel",
                        json!({
                            "taskId": nested_args
                                .string(&["task-id", "taskId"])
                                .or_else(|| payload_string(payload, "taskId"))
                                .ok_or_else(|| "runtime tasks cancel requires --task-id".to_string())?
                        }),
                    ),
                    _ => Err(format!("unsupported runtime tasks action: {sub}")),
                }
            }
            "background" => {
                let sub = tokens.get(1).map(String::as_str).unwrap_or("list");
                let nested_args = parse_cli_args(&tokens[2..])?;
                match sub {
                    "list" => self.call_channel("background-tasks:list", json!({})),
                    "get" => self.call_channel(
                        "background-tasks:get",
                        json!({
                            "taskId": nested_args
                                .string(&["task-id", "taskId"])
                                .or_else(|| payload_string(payload, "taskId"))
                                .ok_or_else(|| "runtime background get requires --task-id".to_string())?
                        }),
                    ),
                    "cancel" => self.call_channel(
                        "background-tasks:cancel",
                        json!({
                            "taskId": nested_args
                                .string(&["task-id", "taskId"])
                                .or_else(|| payload_string(payload, "taskId"))
                                .ok_or_else(|| "runtime background cancel requires --task-id".to_string())?
                        }),
                    ),
                    _ => Err(format!("unsupported runtime background action: {sub}")),
                }
            }
            "team" => {
                let sub = tokens.get(1).map(String::as_str).unwrap_or("list-sessions");
                let nested_args = parse_cli_args(&tokens[2..])?;
                let merged = || merge_payload(&nested_args.options, payload);
                let session_payload = || {
                    json!({
                        "sessionId": nested_args
                            .string(&["session-id", "sessionId"])
                            .or_else(|| payload_string(payload, "sessionId"))
                            .unwrap_or_default()
                    })
                };
                match sub {
                    "list-sessions" | "sessions" => {
                        self.call_channel("team-runtime:list-sessions", json!({}))
                    }
                    "create-session" => {
                        let payload = merged();
                        require_confirmed_team_plan("team.session.create", &payload)?;
                        self.call_channel("team-runtime:create-session", payload)
                    }
                    "get-session" => self.call_channel("team-runtime:get-session", session_payload()),
                    "pause-session" => {
                        self.call_channel("team-runtime:pause-session", session_payload())
                    }
                    "resume-session" => {
                        self.call_channel("team-runtime:resume-session", session_payload())
                    }
                    "archive-session" => {
                        self.call_channel("team-runtime:archive-session", session_payload())
                    }
                    "list-members" | "members" => {
                        self.call_channel("team-runtime:list-members", session_payload())
                    }
                    "add-member" | "spawn-member" => {
                        let payload = merged();
                        require_confirmed_team_plan("team.member.spawn", &payload)?;
                        self.call_channel("team-runtime:add-member", payload)
                    }
                    "list-tasks" | "tasks" => {
                        self.call_channel("team-runtime:list-tasks", session_payload())
                    }
                    "create-task" => self.call_channel("team-runtime:create-task", merged()),
                    "update-task" => self.call_channel("team-runtime:update-task", merged()),
                    "send-message" => self.call_channel("team-runtime:send-message", merged()),
                    "read-mailbox" => self.call_channel("team-runtime:read-mailbox", merged()),
                    "request-report" => {
                        self.call_channel("team-runtime:request-report", merged())
                    }
                    "submit-report" => self.call_channel("team-runtime:submit-report", merged()),
                    "list-reports" => self.call_channel("team-runtime:list-reports", merged()),
                    "tick-reports" => {
                        self.call_channel("team-runtime:tick-reports", session_payload())
                    }
                    "list-agent-backends" | "backends" => {
                        self.call_channel("team-runtime:list-agent-backends", json!({}))
                    }
                    "list-tools" => self.call_channel("team-runtime:list-tools", json!({})),
                    "execute-tool" => self.call_channel("team-runtime:execute-tool", merged()),
                    "mcp-contract" => self.call_channel("team-runtime:mcp-contract", json!({})),
                    "execute-mcp-tool" => {
                        self.call_channel("team-runtime:execute-mcp-tool", merged())
                    }
                    _ => Err(format!("unsupported runtime team action: {sub}")),
                }
            }
            "session-enter-diagnostics" => self.call_channel(
                "chat:create-diagnostics-session",
                json!({
                    "title": args.string(&["title"]).or_else(|| payload_string(payload, "title")),
                    "contextId": args
                        .string(&["context-id", "contextId"])
                        .or_else(|| payload_string(payload, "contextId")),
                    "contextType": args
                        .string(&["context-type", "contextType"])
                        .or_else(|| payload_string(payload, "contextType")),
                }),
            ),
            "session-bridge" => {
                let sub = tokens.get(1).map(String::as_str).unwrap_or("status");
                let nested_args = parse_cli_args(&tokens[2..])?;
                match sub {
                    "status" => self.call_channel("session-bridge:status", json!({})),
                    "list-sessions" => self.call_channel("session-bridge:list-sessions", json!({})),
                    "get-session" => self.call_channel(
                        "session-bridge:get-session",
                        json!({
                            "sessionId": nested_args
                                .string(&["session-id", "sessionId"])
                                .or_else(|| payload_string(payload, "sessionId"))
                                .ok_or_else(|| "runtime session-bridge get-session requires --session-id".to_string())?
                        }),
                    ),
                    _ => Err(format!("unsupported runtime session-bridge action: {sub}")),
                }
            }
            _ => Err(format!("unsupported runtime action: {action}")),
        }
    }

    fn handle_approval_request(&self, payload: &Value) -> Result<Value, String> {
        let title = payload_string(payload, "title").unwrap_or_else(|| "需要人工审批".to_string());
        let summary = payload_string(payload, "summary")
            .or_else(|| payload_string(payload, "description"))
            .unwrap_or_else(|| title.clone());
        let body = payload_string(payload, "body")
            .or_else(|| payload_string(payload, "details"))
            .unwrap_or_else(|| summary.clone());
        let wait_for_decision = payload
            .get("waitForDecision")
            .and_then(Value::as_bool)
            .unwrap_or(true);
        let timeout_ms = payload
            .get("timeoutMs")
            .and_then(Value::as_u64)
            .unwrap_or(30 * 60 * 1000)
            .clamp(1_000, 6 * 60 * 60 * 1000);
        let call_id = self
            .tool_call_id
            .map(ToString::to_string)
            .unwrap_or_else(|| make_id("approval-call"));
        let mut docket_payload = payload.as_object().cloned().unwrap_or_default();
        docket_payload
            .entry("sourceKind".to_string())
            .or_insert_with(|| json!("agent_approval"));
        docket_payload
            .entry("sourceId".to_string())
            .or_insert_with(|| json!(call_id.clone()));
        docket_payload
            .entry("callId".to_string())
            .or_insert_with(|| json!(call_id.clone()));
        docket_payload
            .entry("sessionId".to_string())
            .or_insert_with(|| json!(self.session_id.unwrap_or_default()));
        docket_payload.insert("title".to_string(), json!(title));
        docket_payload.insert("summary".to_string(), json!(summary));
        docket_payload.insert("body".to_string(), json!(body));
        docket_payload
            .entry("decisionType".to_string())
            .or_insert_with(|| json!("approve_reject"));
        docket_payload
            .entry("priority".to_string())
            .or_insert_with(|| json!("normal"));
        docket_payload
            .entry("riskLevel".to_string())
            .or_insert_with(|| json!("medium"));
        docket_payload
            .entry("proposedAction".to_string())
            .or_insert_with(|| json!({ "kind": "agent_approval", "callId": call_id }));

        let docket = self.call_channel(
            "team-runtime:create-review-docket",
            Value::Object(docket_payload),
        )?;
        let docket_id = docket
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| "approval.request did not receive a docket id".to_string())?
            .to_string();
        if !wait_for_decision {
            return Ok(json!({
                "success": true,
                "status": "pending",
                "approvalId": docket_id,
                "docket": docket,
            }));
        }
        let receiver = register_review_docket_waiter(self.state, &docket_id)?;
        match receiver.recv_timeout(Duration::from_millis(timeout_ms)) {
            Ok(outcome) => Ok(json!({
                "success": true,
                "status": "resolved",
                "approvalId": docket_id,
                "docket": docket,
                "outcome": outcome,
            })),
            Err(RecvTimeoutError::Timeout) => {
                clear_review_docket_waiters(self.state, &docket_id)?;
                Ok(json!({
                    "success": false,
                    "status": "timeout",
                    "approvalId": docket_id,
                    "docket": docket,
                    "message": "approval.request timed out before the user made a decision",
                }))
            }
            Err(RecvTimeoutError::Disconnected) => {
                Err("approval.request waiter disconnected".to_string())
            }
        }
    }

    fn handle_cli_runtime(&self, tokens: &[String], payload: &Value) -> Result<Value, String> {
        let Some(action) = tokens.first().map(String::as_str) else {
            return Ok(help_response(Some("cli_runtime")));
        };
        let args = parse_cli_args(&tokens[1..])?;
        match action {
            "detect" => self.call_channel(
                "cli-runtime:detect",
                json!({
                    "commands": payload_field(payload, "commands")
                        .cloned()
                        .unwrap_or_else(|| json!(args.positionals)),
                    "sessionId": payload_string(payload, "sessionId"),
                    "taskId": payload_string(payload, "taskId"),
                }),
            ),
            "discover" => self.call_channel(
                "cli-runtime:discover",
                json!({
                    "query": args
                        .string(&["query", "q"])
                        .or_else(|| payload_string(payload, "query")),
                    "limit": args
                        .i64(&["limit"])
                        .or_else(|| payload_field(payload, "limit").and_then(Value::as_i64)),
                    "sessionId": payload_string(payload, "sessionId"),
                    "taskId": payload_string(payload, "taskId"),
                }),
            ),
            "inspect" => self.call_channel(
                "cli-runtime:inspect",
                json!({
                    "toolId": args
                        .string(&["tool-id", "toolId"])
                        .or_else(|| payload_string(payload, "toolId"))
                        .or_else(|| payload_string(payload, "id")),
                    "command": args
                        .string(&["command", "executable", "name", "id"])
                        .or_else(|| payload_string(payload, "command"))
                        .or_else(|| payload_string(payload, "executable"))
                        .or_else(|| payload_string(payload, "name"))
                        .or_else(|| payload_string(payload, "id")),
                    "executable": args
                        .string(&["executable", "command", "name", "id"])
                        .or_else(|| payload_string(payload, "executable"))
                        .or_else(|| payload_string(payload, "command"))
                        .or_else(|| payload_string(payload, "name"))
                        .or_else(|| payload_string(payload, "id")),
                }),
            ),
            "diagnose" => self.call_channel(
                "cli-runtime:diagnose",
                json!({
                    "command": args
                        .string(&["command", "executable", "name", "id"])
                        .or_else(|| payload_string(payload, "command"))
                        .or_else(|| payload_string(payload, "executable"))
                        .or_else(|| payload_string(payload, "name"))
                        .or_else(|| payload_string(payload, "id"))
                        .or_else(|| args.positionals.first().cloned())
                        .ok_or_else(|| "cli_runtime diagnose requires --command".to_string())?,
                    "environmentId": args
                        .string(&["environment-id", "environmentId"])
                        .or_else(|| payload_string(payload, "environmentId")),
                    "cwd": args
                        .string(&["cwd"])
                        .or_else(|| payload_string(payload, "cwd")),
                    "executionMode": args
                        .string(&["execution-mode", "executionMode", "mode"])
                        .or_else(|| payload_string(payload, "executionMode"))
                        .or_else(|| payload_string(payload, "mode")),
                }),
            ),
            "environment" => {
                let sub = tokens.get(1).map(String::as_str).unwrap_or("list");
                let nested_args = parse_cli_args(&tokens[2..])?;
                match sub {
                    "list" => self.call_channel("cli-runtime:list-environments", json!({})),
                    "create" => self.call_channel(
                        "cli-runtime:create-environment",
                        json!({
                            "scope": self
                                .cli_runtime_scope_input(&nested_args, payload, &["name"])
                                .ok_or_else(|| "cli_runtime environment.create requires --scope".to_string())?,
                            "workspaceRoot": nested_args
                                .string(&["workspace-root", "workspaceRoot"])
                                .or_else(|| payload_string(payload, "workspaceRoot")),
                            "taskId": nested_args
                                .string(&["task-id", "taskId"])
                                .or_else(|| payload_string(payload, "taskId")),
                        }),
                    ),
                    _ => Err(format!("unsupported cli_runtime environment action: {sub}")),
                }
            }
            "install" => self.call_channel(
                "cli-runtime:install",
                json!({
                    "environmentId": args
                        .string(&["environment-id", "environmentId"])
                        .or_else(|| payload_string(payload, "environmentId")),
                    "installMethod": args
                        .string(&["install-method", "installMethod"])
                        .or_else(|| payload_string(payload, "installMethod"))
                        .ok_or_else(|| "cli_runtime install requires --install-method".to_string())?,
                    "spec": args
                        .string(&["spec"])
                        .or_else(|| payload_string(payload, "spec"))
                        .or_else(|| payload_string(payload, "installSpec"))
                        .or_else(|| payload_string(payload, "package"))
                        .or_else(|| payload_string(payload, "packageName"))
                        .or_else(|| {
                            if payload_string(payload, "toolName").is_none() {
                                payload_string(payload, "name")
                            } else {
                                None
                            }
                        })
                        .ok_or_else(|| "cli_runtime install requires --spec".to_string())?,
                    "toolName": args
                        .string(&["tool-name", "toolName"])
                        .or_else(|| payload_string(payload, "toolName"))
                        .or_else(|| payload_string(payload, "name")),
                    "executionMode": args
                        .string(&["execution-mode", "executionMode", "mode"])
                        .or_else(|| payload_string(payload, "executionMode"))
                        .or_else(|| payload_string(payload, "mode")),
                    "sessionId": payload_string(payload, "sessionId"),
                    "taskId": payload_string(payload, "taskId"),
                    "runtimeId": payload_string(payload, "runtimeId"),
                    "env": payload_field(payload, "env").cloned().unwrap_or_else(|| json!({})),
                }),
            ),
            "execute" => self.call_channel(
                "cli-runtime:execute",
                json!({
                    "environmentId": args
                        .string(&["environment-id", "environmentId"])
                        .or_else(|| payload_string(payload, "environmentId")),
                    "toolId": args
                        .string(&["tool-id", "toolId"])
                        .or_else(|| payload_string(payload, "toolId")),
                    "argv": payload_field(payload, "argv")
                        .cloned()
                        .or_else(|| {
                            if args.positionals.is_empty() {
                                None
                            } else {
                                Some(json!(args.positionals))
                            }
                        })
                        .ok_or_else(|| "cli_runtime execute requires argv".to_string())?,
                    "cwd": args
                        .string(&["cwd"])
                        .or_else(|| payload_string(payload, "cwd")),
                    "sessionId": payload_string(payload, "sessionId"),
                    "taskId": payload_string(payload, "taskId"),
                    "runtimeId": payload_string(payload, "runtimeId"),
                    "executionMode": args
                        .string(&["execution-mode", "executionMode", "mode"])
                        .or_else(|| payload_string(payload, "executionMode"))
                        .or_else(|| payload_string(payload, "mode")),
                    "usePty": payload_field(payload, "usePty").cloned().unwrap_or_else(|| json!(false)),
                    "verificationRules": payload_field(payload, "verificationRules")
                        .cloned()
                        .unwrap_or_else(|| json!([])),
                    "env": payload_field(payload, "env").cloned().unwrap_or_else(|| json!({})),
                }),
            ),
            "get" => self.call_channel(
                "cli-runtime:get-execution",
                json!({
                    "executionId": args
                        .string(&["execution-id", "executionId", "id"])
                        .or_else(|| payload_string(payload, "executionId"))
                        .or_else(|| payload_string(payload, "id"))
                        .ok_or_else(|| "cli_runtime get requires --execution-id".to_string())?,
                    "maxChars": args
                        .i64(&["max-chars", "maxChars"])
                        .or_else(|| payload_field(payload, "maxChars").and_then(Value::as_i64)),
                }),
            ),
            "execution" => {
                let sub = tokens.get(1).map(String::as_str).unwrap_or("get");
                let nested_args = parse_cli_args(&tokens[2..])?;
                match sub {
                    "get" | "poll" => self.call_channel(
                        "cli-runtime:get-execution",
                        json!({
                            "executionId": nested_args
                                .string(&["execution-id", "executionId", "id"])
                                .or_else(|| payload_string(payload, "executionId"))
                                .or_else(|| payload_string(payload, "id"))
                                .ok_or_else(|| "cli_runtime execution.get requires --execution-id".to_string())?,
                            "maxChars": nested_args
                                .i64(&["max-chars", "maxChars"])
                                .or_else(|| payload_field(payload, "maxChars").and_then(Value::as_i64)),
                        }),
                    ),
                    _ => Err(format!("unsupported cli_runtime execution action: {sub}")),
                }
            }
            "verify" => self.call_channel(
                "cli-runtime:verify",
                json!({
                    "executionId": args
                        .string(&["execution-id", "executionId"])
                        .or_else(|| payload_string(payload, "executionId"))
                        .ok_or_else(|| "cli_runtime verify requires --execution-id".to_string())?,
                    "rules": payload_field(payload, "rules")
                        .cloned()
                        .unwrap_or_else(|| json!([])),
                }),
            ),
            "escalation" => {
                let sub = tokens.get(1).map(String::as_str).unwrap_or("");
                let nested_args = parse_cli_args(&tokens[2..])?;
                match sub {
                    "approve" => self.call_channel(
                        "cli-runtime:approve-escalation",
                        json!({
                            "escalationId": nested_args
                                .string(&["escalation-id", "escalationId"])
                                .or_else(|| payload_string(payload, "escalationId"))
                                .ok_or_else(|| "cli_runtime escalation.approve requires --escalation-id".to_string())?,
                            "scope": nested_args
                                .string(&["scope"])
                                .or_else(|| payload_string(payload, "scope"))
                                .ok_or_else(|| "cli_runtime escalation.approve requires --scope".to_string())?,
                        }),
                    ),
                    "deny" => self.call_channel(
                        "cli-runtime:deny-escalation",
                        json!({
                            "escalationId": nested_args
                                .string(&["escalation-id", "escalationId"])
                                .or_else(|| payload_string(payload, "escalationId"))
                                .ok_or_else(|| "cli_runtime escalation.deny requires --escalation-id".to_string())?,
                            "reason": nested_args
                                .string(&["reason"])
                                .or_else(|| payload_string(payload, "reason")),
                        }),
                    ),
                    _ => Err(format!("unsupported cli_runtime escalation action: {sub}")),
                }
            }
            _ => Err(format!("unsupported cli_runtime action: {action}")),
        }
    }

    fn handle_settings(&self, tokens: &[String], payload: &Value) -> Result<Value, String> {
        let Some(action) = tokens.first().map(String::as_str) else {
            return Ok(help_response(Some("settings")));
        };
        match action {
            "summary" => self.call_channel("db:get-settings", json!({})).map(|value| {
                json!({
                    "defaultAiSourceId": value.get("default_ai_source_id").cloned().unwrap_or(Value::Null),
                    "modelName": value.get("model_name").cloned().unwrap_or(Value::Null),
                    "apiEndpoint": value.get("api_endpoint").cloned().unwrap_or(Value::Null),
                    "hasApiKey": value
                        .get("api_key")
                        .and_then(Value::as_str)
                        .map(|item| !item.trim().is_empty())
                        .unwrap_or(false),
                    "hasEmbeddingKey": value
                        .get("embedding_key")
                        .and_then(Value::as_str)
                        .map(|item| !item.trim().is_empty())
                        .unwrap_or(false),
                    "hasMcpConfig": value
                        .get("mcp_servers_json")
                        .and_then(Value::as_str)
                        .map(|item| item != "[]" && !item.trim().is_empty())
                        .unwrap_or(false)
                })
            }),
            "get" => self.call_channel("db:get-settings", json!({})),
            "set" => self.call_channel("db:save-settings", payload.clone()),
            _ => Err(format!("unsupported settings action: {action}")),
        }
    }

    fn handle_skills(&self, tokens: &[String], payload: &Value) -> Result<Value, String> {
        let Some(action) = tokens.first().map(String::as_str) else {
            return Ok(help_response(Some("skills")));
        };
        let args = parse_cli_args(&tokens[1..])?;
        match action {
            "list" => self.call_channel("skills:list", json!({ "includeBody": false })),
            "invoke" => self.call_channel(
                "skills:invoke",
                json!({
                    "name": skill_name_from_args_or_payload(&args, payload)
                        .ok_or_else(|| "skills invoke requires --name".to_string())?,
                    "sessionId": self.session_id,
                    "runtimeMode": self.runtime_mode,
                }),
            ),
            "enable" => self.call_channel(
                "skills:enable",
                json!({
                    "name": skill_name_from_args_or_payload(&args, payload)
                        .ok_or_else(|| "skills enable requires --name".to_string())?
                }),
            ),
            "create" => self.call_channel(
                "skills:create",
                json!({
                    "name": skill_name_from_args_or_payload(&args, payload)
                        .ok_or_else(|| "skills create requires --name".to_string())?
                }),
            ),
            "save" => self.call_channel(
                "skills:save",
                json!({
                    "location": args
                        .string(&["location"])
                        .or_else(|| payload_string_alias(payload, &["location"]))
                        .ok_or_else(|| "skills save requires --location".to_string())?,
                    "content": args
                        .string(&["content"])
                        .or_else(|| payload_string_alias(payload, &["content"]))
                        .unwrap_or_default(),
                }),
            ),
            "disable" => self.call_channel(
                "skills:disable",
                json!({
                    "name": skill_name_from_args_or_payload(&args, payload)
                        .ok_or_else(|| "skills disable requires --name".to_string())?
                }),
            ),
            "uninstall" | "delete" => self.call_channel(
                "skills:uninstall",
                json!({
                    "name": skill_name_from_args_or_payload(&args, payload)
                        .ok_or_else(|| "skills uninstall requires --name".to_string())?,
                    "scope": args
                        .string(&["scope"])
                        .or_else(|| payload_string_alias(payload, &["scope"])),
                }),
            ),
            "market-install" => self.call_channel(
                "skills:market-install",
                json!({
                    "slug": args
                        .string(&["slug"])
                        .or_else(|| args.positionals.first().cloned())
                        .ok_or_else(|| "skills market-install requires --slug".to_string())?
                }),
            ),
            "install-from-repo" | "install-from-github" => self.call_channel(
                "skills:install-from-repo",
                json!({
                    "source": args
                        .string(&["source", "url", "repo"])
                        .or_else(|| args.positionals.first().cloned())
                        .or_else(|| payload_string_alias(payload, &["source", "url", "repo"]))
                        .ok_or_else(|| "skills install-from-repo requires --source".to_string())?,
                    "ref": args
                        .string(&["ref"])
                        .or_else(|| payload_string_alias(payload, &["ref", "refName"])),
                    "path": args
                        .string(&["path"])
                        .or_else(|| payload_string_alias(payload, &["path"])),
                    "paths": payload_field(payload, "paths").cloned().unwrap_or(Value::Null),
                    "scope": args
                        .string(&["scope"])
                        .or_else(|| payload_string_alias(payload, &["scope"])),
                }),
            ),
            _ => Err(format!("unsupported skills action: {action}")),
        }
    }

    fn handle_mcp(&self, tokens: &[String], payload: &Value) -> Result<Value, String> {
        let Some(action) = tokens.first().map(String::as_str) else {
            return Ok(help_response(Some("mcp")));
        };
        let args = parse_cli_args(&tokens[1..])?;
        let server_value = payload_field(payload, "server")
            .cloned()
            .unwrap_or_else(|| json!({}));
        let parse_server = || -> Result<McpServerRecord, String> {
            if let Some(server_id) = payload_string(payload, "serverId")
                .or_else(|| payload_string(payload, "id"))
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
            {
                return with_store(self.state, |store| {
                    store
                        .mcp_servers
                        .iter()
                        .find(|server| server.id == server_id || server.name == server_id)
                        .cloned()
                        .ok_or_else(|| format!("MCP server `{server_id}` not found"))
                });
            }
            serde_json::from_value(server_value.clone()).map_err(|error| error.to_string())
        };
        match action {
            "list" => commands::mcp_tools::mcp_list_value(self.state),
            "add" => {
                let mut request = merge_payload(&args.options, payload);
                if let Some(object) = request.as_object_mut() {
                    if !object.contains_key("name") {
                        if let Some(name) = args.positionals.first() {
                            object.insert("name".to_string(), Value::String(name.clone()));
                        }
                    }
                    if !object.contains_key("command") && !object.contains_key("url") {
                        if let Some(command) = args.positionals.get(1) {
                            object.insert("command".to_string(), Value::String(command.clone()));
                        }
                    }
                    if !object.contains_key("args") && args.positionals.len() > 2 {
                        object.insert(
                            "args".to_string(),
                            json!(args.positionals.iter().skip(2).cloned().collect::<Vec<_>>()),
                        );
                    }
                }
                commands::mcp_tools::mcp_add_value(self.state, &request)
            }
            "get" => {
                let request = merge_mcp_target_payload(&args, payload, "mcp get requires --id")?;
                commands::mcp_tools::mcp_get_value(self.state, &request)
            }
            "remove" | "delete" => {
                let request = merge_mcp_target_payload(&args, payload, "mcp remove requires --id")?;
                commands::mcp_tools::mcp_remove_value(self.state, &request)
            }
            "enable" => {
                let request = merge_mcp_target_payload(&args, payload, "mcp enable requires --id")?;
                commands::mcp_tools::mcp_set_enabled_value(self.state, &request, true)
            }
            "disable" => {
                let request =
                    merge_mcp_target_payload(&args, payload, "mcp disable requires --id")?;
                commands::mcp_tools::mcp_set_enabled_value(self.state, &request, false)
            }
            "sessions" => commands::mcp_tools::mcp_sessions_value(self.state),
            "oauth-status" => commands::mcp_tools::mcp_oauth_status_value(
                self.state,
                &args
                    .string(&["id", "server-id"])
                    .or_else(|| payload_string(payload, "serverId"))
                    .or_else(|| payload_string(payload, "id"))
                    .or_else(|| args.positionals.first().cloned())
                    .ok_or_else(|| "mcp oauth-status requires --id".to_string())?,
            ),
            "save" => commands::mcp_tools::mcp_save_value(self.state, payload),
            "test" => commands::mcp_tools::mcp_probe_value(self.state, &parse_server()?),
            "call" => commands::mcp_tools::mcp_call_value(
                self.state,
                &parse_server()?,
                &args
                    .string(&["method"])
                    .or_else(|| payload_string(payload, "method"))
                    .unwrap_or_default(),
                payload_field(payload, "params")
                    .cloned()
                    .unwrap_or_else(|| json!({})),
                args.string(&["session-id", "sessionId"])
                    .or_else(|| payload_string(payload, "sessionId")),
            ),
            "list-tools" => commands::mcp_tools::mcp_call_value(
                self.state,
                &parse_server()?,
                "tools/list",
                json!({}),
                args.string(&["session-id", "sessionId"])
                    .or_else(|| payload_string(payload, "sessionId")),
            ),
            "list-resources" => commands::mcp_tools::mcp_call_value(
                self.state,
                &parse_server()?,
                "resources/list",
                json!({}),
                args.string(&["session-id", "sessionId"])
                    .or_else(|| payload_string(payload, "sessionId")),
            ),
            "list-resource-templates" => commands::mcp_tools::mcp_call_value(
                self.state,
                &parse_server()?,
                "resources/templates/list",
                json!({}),
                args.string(&["session-id", "sessionId"])
                    .or_else(|| payload_string(payload, "sessionId")),
            ),
            "disconnect" => commands::mcp_tools::mcp_disconnect_value(self.state, &parse_server()?),
            "disconnect-all" => commands::mcp_tools::mcp_disconnect_all_value(self.state),
            "discover-local" => commands::mcp_tools::mcp_discover_local_value(),
            "import-local" => commands::mcp_tools::mcp_import_local_value(self.state),
            _ => Err(format!("unsupported mcp action: {action}")),
        }
    }

    fn handle_ai(&self, tokens: &[String], payload: &Value) -> Result<Value, String> {
        let Some(action) = tokens.first().map(String::as_str) else {
            return Ok(help_response(Some("ai")));
        };
        let args = parse_cli_args(&tokens[1..])?;
        match action {
            "roles-list" => self.call_channel("ai:roles:list", json!({})),
            "detect-protocol" => self.call_channel(
                "ai:detect-protocol",
                json!({
                    "baseURL": args
                        .string(&["base-url", "baseURL"])
                        .or_else(|| payload_string(payload, "baseURL"))
                        .unwrap_or_default(),
                    "presetId": args
                        .string(&["preset-id", "presetId"])
                        .or_else(|| payload_string(payload, "presetId")),
                    "protocol": args
                        .string(&["protocol"])
                        .or_else(|| payload_string(payload, "protocol")),
                }),
            ),
            "test-connection" => self.call_channel(
                "ai:test-connection",
                json!({
                    "baseURL": args
                        .string(&["base-url", "baseURL"])
                        .or_else(|| payload_string(payload, "baseURL"))
                        .unwrap_or_default(),
                    "apiKey": args
                        .string(&["api-key", "apiKey"])
                        .or_else(|| payload_string(payload, "apiKey")),
                    "presetId": args
                        .string(&["preset-id", "presetId"])
                        .or_else(|| payload_string(payload, "presetId")),
                    "protocol": args
                        .string(&["protocol"])
                        .or_else(|| payload_string(payload, "protocol")),
                }),
            ),
            _ => Err(format!("unsupported ai action: {action}")),
        }
    }

    fn handle_video_project_create(
        &self,
        args: &CliArgs,
        payload: &Value,
    ) -> Result<Value, String> {
        if !video_project_create_requested_explicitly(args, payload) {
            return Err(
                "video project-create requires explicit project workflow confirmation. \
For one-off generation, use `video generate` and keep the output in media/. \
Only create a video project folder when the user explicitly asks for a project/package/editor workflow. \
Pass `--explicit-project-workflow true` or `payload.explicitProjectWorkflow=true` after explicit confirmation."
                    .to_string(),
            );
        }
        let title = args
            .string(&["title"])
            .or_else(|| args.positionals.first().cloned())
            .unwrap_or_else(|| "Untitled Video".to_string());
        let relative = build_video_project_relative_path(args.string(&["path"]));
        let (parent_path, name) = split_parent_and_name(&relative);
        let script_content = payload_string(payload, "content")
            .or_else(|| payload_string(payload, "script"))
            .or_else(|| args.string(&["content", "script", "brief"]))
            .unwrap_or_default();
        self.call_channel(
            "manuscripts:create-file",
            json!({
                "parentPath": parent_path,
                "name": name,
                "title": title.clone(),
                "content": script_content.clone()
            }),
        )?;
        self.call_channel(
            "manuscripts:save",
            json!({
                "path": relative,
                "content": script_content,
                "metadata": {
                    "title": title,
                    "aspectRatio": args.string(&["aspect-ratio", "aspectRatio"]),
                    "duration": args.string(&["duration"]),
                    "mode": args.string(&["mode"]),
                    "draftType": "video",
                    "packageKind": "video"
                }
            }),
        )?;
        let state = self.call_channel(
            "manuscripts:get-video-project-state",
            json!({ "filePath": relative.clone() }),
        )?;
        Ok(json!({
            "success": true,
            "path": relative,
            "videoProjectId": video_project_stem_from_path(&relative),
            "project": state
        }))
    }

    fn handle_video_project_list(&self) -> Result<Value, String> {
        let tree = self.call_channel("manuscripts:list", json!({}))?;
        let mut projects = Vec::<Value>::new();
        collect_video_projects(&tree, &mut projects);
        Ok(json!({ "success": true, "projects": projects }))
    }

    fn handle_video_project_get(&self, args: &CliArgs) -> Result<Value, String> {
        let file_path = self.resolve_video_project_path(
            args.string(&["path", "id", "video-project-id", "videoProjectId"])
                .or_else(|| args.positionals.first().cloned())
                .ok_or_else(|| "video project-get requires --path".to_string())?,
        )?;
        self.call_channel(
            "manuscripts:get-video-project-state",
            json!({
                "filePath": file_path
            }),
        )
    }

    fn handle_video_project_brief(&self, args: &CliArgs, payload: &Value) -> Result<Value, String> {
        let path = self.resolve_video_project_path(
            args.string(&["path", "id", "video-project-id", "videoProjectId"])
                .or_else(|| payload_string(payload, "path"))
                .or_else(|| payload_string(payload, "id"))
                .or_else(|| payload_string(payload, "videoProjectPath"))
                .or_else(|| payload_string(payload, "videoProjectId"))
                .or_else(|| args.positionals.first().cloned())
                .ok_or_else(|| "video project-brief requires --path".to_string())?,
        )?;
        if let Some(content) = payload_string(payload, "content")
            .or_else(|| payload_string(payload, "brief"))
            .or_else(|| args.string(&["content", "brief"]))
        {
            let video_project_id = video_project_stem_from_path(&path);
            let saved = self.call_channel(
                "manuscripts:save-video-project-brief",
                json!({
                    "filePath": path.clone(),
                    "content": content,
                    "source": "user"
                }),
            )?;
            return Ok(json!({
                "success": saved.get("success").and_then(Value::as_bool).unwrap_or(true),
                "path": path,
                "videoProjectId": video_project_id,
                "brief": saved.get("brief").cloned().unwrap_or(Value::Null),
                "project": saved.get("project").cloned().unwrap_or(Value::Null),
                "state": saved.get("state").cloned().unwrap_or(Value::Null)
            }));
        }
        let project = self.call_channel(
            "manuscripts:get-video-project-state",
            json!({ "filePath": path.clone() }),
        )?;
        let project_state = project.get("project").cloned().unwrap_or(Value::Null);
        let video_project_id = video_project_stem_from_path(&path);
        Ok(json!({
            "success": project.get("success").and_then(Value::as_bool).unwrap_or(true),
            "path": path,
            "videoProjectId": video_project_id,
            "brief": project_state.get("brief").cloned().unwrap_or(Value::Null),
            "project": project_state.clone(),
            "videoProject": project_state.clone(),
            "script": project_state.get("scriptBody").cloned().unwrap_or(Value::Null),
            "scriptApproval": project_state.get("scriptApproval").cloned().unwrap_or(Value::Null),
            "assets": project_state.get("assets").cloned().unwrap_or_else(|| json!([])),
            "renderOutput": project_state.get("renderOutput").cloned().unwrap_or(Value::Null)
        }))
    }

    fn handle_video_project_script(
        &self,
        args: &CliArgs,
        payload: &Value,
    ) -> Result<Value, String> {
        let path = self.resolve_video_project_path(
            args.string(&["path", "id", "video-project-id", "videoProjectId"])
                .or_else(|| payload_string(payload, "path"))
                .or_else(|| payload_string(payload, "id"))
                .or_else(|| args.positionals.first().cloned())
                .ok_or_else(|| "video project-script requires --path".to_string())?,
        )?;
        if let Some(content) =
            payload_string(payload, "content").or_else(|| args.string(&["content"]))
        {
            return self.call_channel(
                "manuscripts:save",
                json!({
                    "path": path,
                    "content": content,
                    "metadata": payload_field(payload, "metadata").cloned().unwrap_or_else(|| json!({}))
                }),
            );
        }
        self.call_channel("manuscripts:read", json!(path))
    }

    fn handle_video_project_asset_add(
        &self,
        args: &CliArgs,
        payload: &Value,
    ) -> Result<Value, String> {
        let asset_id = args
            .string(&["asset-id", "assetId"])
            .or_else(|| payload_string(payload, "assetId"))
            .or_else(|| args.positionals.get(1).cloned());
        if let Some(asset_id) = asset_id.filter(|value| !value.trim().is_empty()) {
            let file_path = self.resolve_video_project_path(
                args.string(&["path", "id", "video-project-id", "videoProjectId"])
                    .or_else(|| payload_string(payload, "path"))
                    .or_else(|| payload_string(payload, "id"))
                    .or_else(|| payload_string(payload, "videoProjectPath"))
                    .or_else(|| payload_string(payload, "videoProjectId"))
                    .or_else(|| args.positionals.first().cloned())
                    .ok_or_else(|| "video project-asset-add requires --path".to_string())?,
            )?;
            return self.call_channel(
                "manuscripts:add-package-clip",
                json!({
                    "filePath": file_path,
                    "assetId": asset_id,
                    "track": args.string(&["track"]),
                    "order": args.i64(&["order"]),
                    "durationMs": args.i64(&["duration-ms", "durationMs"])
                }),
            );
        }

        let project_locator = args
            .string(&["id", "video-project-id", "videoProjectId"])
            .or_else(|| payload_string(payload, "id"))
            .or_else(|| payload_string(payload, "videoProjectId"))
            .or_else(|| payload_string(payload, "projectId"))
            .or_else(|| payload_string(payload, "videoProjectPath"))
            .or_else(|| {
                args.string(&["path"]).and_then(|value| {
                    if !std::path::Path::new(&value).is_absolute() && value.contains('/') {
                        Some(value)
                    } else {
                        None
                    }
                })
            })
            .or_else(|| args.positionals.first().cloned())
            .ok_or_else(|| {
                "video project-asset-add requires a project locator (--id or --path)".to_string()
            })?;
        let file_path = self.resolve_video_project_path(project_locator)?;
        let source_path = args
            .string(&["source", "source-path", "sourcePath"])
            .or_else(|| payload_string(payload, "sourcePath"))
            .or_else(|| {
                args.string(&["path"]).and_then(|value| {
                    if std::path::Path::new(&value).is_absolute() {
                        Some(value)
                    } else {
                        None
                    }
                })
            })
            .or_else(|| args.positionals.get(1).cloned())
            .ok_or_else(|| {
                "video project-asset-add requires --source-path when --asset-id is absent"
                    .to_string()
            })?;
        self.call_channel(
            "manuscripts:attach-package-file",
            json!({
                "filePath": file_path,
                "sourcePath": source_path,
                "kind": args.string(&["kind"]).or_else(|| payload_string(payload, "kind")),
                "label": args.string(&["label"]).or_else(|| payload_string(payload, "label")),
                "role": args.string(&["role"]).or_else(|| payload_string(payload, "role"))
            }),
        )
    }

    fn handle_image_generate(&self, args: &CliArgs, payload: &Value) -> Result<Value, String> {
        let mut merged = build_generation_payload(args, payload);
        if self.session_id.is_some() {
            apply_agent_image_generation_defaults(&mut merged);
        }
        let subject_matches = self.collect_subject_matches(args, payload, 4)?;
        let subject_reference_images = subject_matches
            .iter()
            .flat_map(|subject| value_string_list(subject.get("absoluteImagePaths"), 4))
            .take(4)
            .collect::<Vec<_>>();
        let mut reference_images = value_string_list(merged.get("referenceImages"), 4);
        if reference_images.is_empty() {
            reference_images = value_string_list(merged.get("images"), 4);
        }
        reference_images.extend(subject_reference_images);
        reference_images = self.resolve_reference_image_inputs(reference_images);
        dedupe_string_list(&mut reference_images, 4);
        let image_plan_items = extract_image_plan_items(merged.get("imagePlanItems"));
        let requested_count = requested_image_generation_count(&merged, image_plan_items.len());
        let multi_image_agent_turn = requested_count > 1 && self.session_id.is_some();
        let plan_confirmed = payload_bool(&merged, &["planConfirmed"]).unwrap_or(false);
        let auto_execution_agent = self.session_generation_agent_auto_execution_enabled();
        let shared_style_guide =
            payload_string(&merged, "sharedStyleGuide").filter(|item| !item.trim().is_empty());
        let base_prompt = payload_string(&merged, "prompt").unwrap_or_default();

        if multi_image_agent_turn {
            self.run_preflight_multi_image_skill_activation();
            if image_plan_items.is_empty() {
                let required = if auto_execution_agent {
                    vec!["sharedStyleGuide", "imagePlanItems"]
                } else {
                    vec!["planConfirmed", "sharedStyleGuide", "imagePlanItems"]
                };
                let hint = if auto_execution_agent {
                    "Agent 模式可自动执行；请先补齐多图顺序表、统一风格锚点和 imagePlanItems，然后直接再次调用 image.generate。"
                } else {
                    "先输出多图顺序表、统一风格锚点，并等待用户确认；确认后再调用 image.generate。"
                };
                return Err(app_cli_error_json(
                    Some("image.generate"),
                    "IMAGE_PLAN_REQUIRED",
                    "multi-image generation requires an approved image plan before execution",
                    false,
                    Some(json!({
                        "required": required,
                        "count": requested_count,
                        "hint": hint
                    })),
                ));
            }
            if shared_style_guide.is_none() {
                let hint = if auto_execution_agent {
                    "Agent 模式可自动执行；为整组图片补一份统一风格锚点，再直接继续生成。"
                } else {
                    "为整组图片补一份统一风格锚点，再继续生成。"
                };
                return Err(app_cli_error_json(
                    Some("image.generate"),
                    "IMAGE_STYLE_GUIDE_REQUIRED",
                    "multi-image generation requires a sharedStyleGuide",
                    false,
                    Some(json!({
                        "count": image_plan_items.len(),
                        "hint": hint
                    })),
                ));
            }
            if !plan_confirmed && !auto_execution_agent {
                return Err(app_cli_error_json(
                    Some("image.generate"),
                    "IMAGE_PLAN_CONFIRMATION_REQUIRED",
                    "multi-image generation requires explicit user confirmation",
                    false,
                    Some(json!({
                        "count": image_plan_items.len(),
                        "hint": "先向用户展示多图方案并等待确认；确认后传入 planConfirmed=true。"
                    })),
                ));
            }
        }

        if let Some(object) = merged.as_object_mut() {
            object.remove("model");
            if !reference_images.is_empty() {
                object.insert("referenceImages".to_string(), json!(reference_images));
                let generation_mode = object
                    .get("generationMode")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .unwrap_or("");
                if generation_mode.is_empty() {
                    object.insert("generationMode".to_string(), json!("reference-guided"));
                }
            }
            if requested_count > 1 {
                object.insert("count".to_string(), json!(requested_count));
            }
            if !image_plan_items.is_empty() {
                let compiled_items = image_plan_items
                    .iter()
                    .enumerate()
                    .map(|(index, item)| {
                        if item.prompt.trim().is_empty() {
                            return Err(app_cli_error_json(
                                Some("image.generate"),
                                "IMAGE_PLAN_ITEM_PROMPT_REQUIRED",
                                "each imagePlanItems entry must include a prompt",
                                false,
                                Some(json!({
                                    "index": index,
                                    "title": item.title,
                                })),
                            ));
                        }
                        Ok(json!({
                            "title": item.title,
                            "prompt": item.prompt,
                            "copy": item.copy,
                            "compiledPrompt": compile_image_batch_prompt(
                                &base_prompt,
                                shared_style_guide.as_deref(),
                                item,
                                index,
                                image_plan_items.len(),
                            ),
                        }))
                    })
                    .collect::<Result<Vec<_>, String>>()?;
                object.insert("count".to_string(), json!(compiled_items.len()));
                object.insert("imagePlanItems".to_string(), json!(compiled_items));
            }
            object
                .entry("source".to_string())
                .or_insert_with(|| json!("tool"));
            if let Some(session_id) = self.session_id {
                object.insert("sessionId".to_string(), json!(session_id));
            }
            if let Some(tool_call_id) = self.tool_call_id {
                object.insert("toolCallId".to_string(), json!(tool_call_id));
                object.insert("toolName".to_string(), json!("workflow"));
            }
        }
        match image_generation_delivery_mode(self.session_id, &merged, requested_count) {
            ImageGenerationDeliveryMode::InlineWait => {
                self.emit_tool_partial("图片生成任务已提交，正在等待生成完成。");
                return self.call_channel("image-gen:generate", merged);
            }
            ImageGenerationDeliveryMode::BackgroundFollowup => {
                self.emit_tool_partial(
                    "多图生成任务已提交到媒体 runtime，后台任务将持续跟进结果。",
                );
                let submitted = self.call_channel("generation:submit-image", merged)?;
                let Some(job_id) = submitted.get("jobId").and_then(Value::as_str) else {
                    return Ok(submitted);
                };
                let follow_up = self
                    .session_id
                    .map(|session_id| {
                        crate::media_runtime::spawn_media_job_followup(
                            self.app,
                            self.runtime_mode,
                            session_id,
                            job_id,
                            requested_count,
                        )
                    })
                    .transpose();
                return Ok(match follow_up {
                    Ok(Some(follow_up)) => json!({
                        "success": true,
                        "submitted": submitted,
                        "followUp": follow_up,
                    }),
                    Ok(None) => submitted,
                    Err(error) => json!({
                        "success": true,
                        "submitted": submitted,
                        "followUp": {
                            "success": false,
                            "error": error,
                        },
                    }),
                });
            }
            ImageGenerationDeliveryMode::AsyncSubmit => {}
        }
        self.emit_tool_partial("图片生成任务已提交到媒体 runtime，正在排队执行。");
        self.call_channel("generation:submit-image", merged)
    }

    fn run_preflight_multi_image_skill_activation(&self) {
        let Some(session_id) = self.session_id else {
            return;
        };
        let item = with_store(self.state, |store| {
            Ok(preflight_skill_activation_item(
                &store.skills,
                self.runtime_mode,
                IMAGE_DIRECTOR_SKILL_NAME,
            ))
        })
        .ok()
        .flatten();
        let Some((name, description)) = item else {
            return;
        };
        let call_id = make_id("tool-call");
        emit_runtime_tool_request(
            self.app,
            Some(session_id),
            &call_id,
            "workflow",
            json!({
                "action": "skills.invoke",
                "payload": { "name": name },
            }),
            Some("Preflight skill activation before multi-image generation"),
        );
        let invoke_result = self.call_channel(
            "skills:invoke",
            json!({
                "name": name,
                "sessionId": session_id,
                "runtimeMode": self.runtime_mode,
            }),
        );
        match invoke_result {
            Ok(result) => {
                let envelope = json!({
                    "ok": true,
                    "action": "skills.invoke",
                    "data": result,
                });
                let output = serde_json::to_string_pretty(&envelope)
                    .unwrap_or_else(|_| envelope.to_string());
                emit_runtime_tool_result(
                    self.app,
                    Some(session_id),
                    &call_id,
                    "workflow",
                    true,
                    &output,
                );
            }
            Err(error) => {
                let failure = app_cli_error_json(
                    Some("skills.invoke"),
                    "ACTION_FAILED",
                    &error,
                    false,
                    Some(json!({ "activationSource": "host.multi-image-preflight" })),
                );
                emit_runtime_tool_result(
                    self.app,
                    Some(session_id),
                    &call_id,
                    "workflow",
                    false,
                    &failure,
                );
                return;
            }
        }
        emit_runtime_task_checkpoint_saved(
            self.app,
            None,
            Some(session_id),
            "chat.skill_activated",
            "skill activated",
            Some(json!({
                "name": name,
                "description": description,
                "runtimeMode": self.runtime_mode,
                "activationSource": "host.multi-image-preflight",
            })),
        );
    }

    fn emit_tool_partial(&self, content: &str) {
        let Some(tool_call_id) = self.tool_call_id else {
            return;
        };
        let trimmed = content.trim();
        if trimmed.is_empty() {
            return;
        }
        emit_runtime_tool_partial(self.app, self.session_id, tool_call_id, "workflow", trimmed);
    }

    fn resolve_reference_image_inputs(&self, inputs: Vec<String>) -> Vec<String> {
        let Some(session_id) = self.session_id else {
            return inputs;
        };
        resolve_session_file_reference_inputs(self.state, session_id, inputs)
    }

    fn handle_video_generate(&self, args: &CliArgs, payload: &Value) -> Result<Value, String> {
        let mut merged = build_generation_payload(args, payload);
        let wait_for_completion = video_generation_should_wait(self.session_id, &merged);
        let video_project_path = self
            .video_project_locator_from_generate(args, payload)
            .map(|locator| self.resolve_video_project_path(locator))
            .transpose()?;
        let video_project_state = video_project_path
            .as_ref()
            .map(|project_path| {
                self.call_channel(
                    "manuscripts:get-video-project-state",
                    json!({ "filePath": project_path }),
                )
            })
            .transpose()?;
        let subject_matches = self.collect_subject_matches(args, payload, 5)?;
        let subject_reference_images = subject_matches
            .iter()
            .flat_map(|subject| value_string_list(subject.get("absoluteImagePaths"), 1))
            .take(5)
            .collect::<Vec<_>>();
        let mut reference_images = value_string_list(merged.get("referenceImages"), 5);
        let project_reference_images = video_project_state
            .as_ref()
            .map(|state| extract_video_project_reference_images(state, 5))
            .unwrap_or_default();
        if reference_images.is_empty() && !project_reference_images.is_empty() {
            reference_images.extend(project_reference_images);
        }
        reference_images.extend(subject_reference_images);
        reference_images = self.resolve_reference_image_inputs(reference_images);
        dedupe_string_list(&mut reference_images, 5);
        let explicit_driving_audio = args
            .string(&["driving-audio", "audio-url"])
            .or_else(|| payload_string(payload, "drivingAudio"))
            .filter(|item| !item.trim().is_empty());
        let mut inferred_driving_audio = explicit_driving_audio.clone().or_else(|| {
            subject_matches.iter().find_map(|subject| {
                subject
                    .get("absoluteVoicePath")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|item| !item.is_empty())
                    .map(ToString::to_string)
            })
        });
        if let Some(driving_audio) = inferred_driving_audio.take() {
            inferred_driving_audio = self
                .resolve_reference_image_inputs(vec![driving_audio])
                .into_iter()
                .next();
        }
        let resolved_first_clip = payload_string(&merged, "firstClip")
            .map(|first_clip| self.resolve_reference_image_inputs(vec![first_clip]))
            .and_then(|items| items.into_iter().next());
        if let Some(object) = merged.as_object_mut() {
            if !reference_images.is_empty() {
                object.insert("referenceImages".to_string(), json!(reference_images));
                if object
                    .get("generationMode")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .trim()
                    .is_empty()
                {
                    object.insert("generationMode".to_string(), json!("reference-guided"));
                }
            }
            if let Some(driving_audio) = inferred_driving_audio {
                object.insert("drivingAudio".to_string(), json!(driving_audio));
            }
            if let Some(first_clip) = resolved_first_clip {
                object.insert("firstClip".to_string(), json!(first_clip));
            }
            if let Some(project_path) = video_project_path.clone() {
                object.insert("videoProjectPath".to_string(), json!(project_path));
            }
            if let Some(session_id) = self.session_id {
                object.insert("sessionId".to_string(), json!(session_id));
            }
            if let Some(tool_call_id) = self.tool_call_id {
                object.insert("toolCallId".to_string(), json!(tool_call_id));
                object.insert("toolName".to_string(), json!("workflow"));
            }
        }
        apply_video_storyboard_payload_defaults(&mut merged, video_project_state.as_ref());
        if let Some(compiled_prompt) =
            compile_video_generation_prompt(&merged, video_project_state.as_ref())
        {
            if let Some(object) = merged.as_object_mut() {
                object.insert("prompt".to_string(), json!(compiled_prompt));
            }
        }
        if !wait_for_completion {
            self.emit_tool_partial("视频生成任务已提交，后台会持续等待结果。");
            let submitted = self.call_channel("generation:submit-video", merged)?;
            let follow_up = submitted
                .get("jobId")
                .and_then(Value::as_str)
                .and_then(|job_id| {
                    self.session_id.map(|session_id| {
                        crate::media_runtime::spawn_media_job_followup_for_kind(
                            self.app,
                            self.runtime_mode,
                            session_id,
                            job_id,
                            "video",
                            1,
                        )
                    })
                })
                .transpose();
            let mut result =
                merge_video_generation_result(submitted, video_project_path, video_project_state);
            if let Some(object) = result.as_object_mut() {
                match follow_up {
                    Ok(Some(follow_up)) => {
                        object.insert("followUp".to_string(), follow_up);
                    }
                    Ok(None) => {}
                    Err(error) => {
                        object.insert(
                            "followUp".to_string(),
                            json!({
                                "success": false,
                                "error": error,
                            }),
                        );
                    }
                }
            }
            return Ok(result);
        }
        self.emit_tool_partial("视频生成任务已提交，正在等待视频完成。");
        let result = self.call_channel("video-gen:generate", merged)?;
        if let Some(project_path) = video_project_path {
            if let Some(assets) = result.get("assets").and_then(Value::as_array) {
                for asset in assets {
                    let Some(asset_id) = asset.get("id").and_then(Value::as_str) else {
                        continue;
                    };
                    self.call_channel(
                        "manuscripts:add-package-clip",
                        json!({
                            "filePath": project_path,
                            "assetId": asset_id
                        }),
                    )?;
                }
            }
            let project_state = self.call_channel(
                "manuscripts:get-video-project-state",
                json!({ "filePath": project_path.clone() }),
            )?;
            return Ok(merge_video_generation_result(
                result,
                Some(project_path),
                Some(project_state),
            ));
        }
        Ok(merge_video_generation_result(result, None, None))
    }

    fn video_project_locator_from_generate(
        &self,
        args: &CliArgs,
        payload: &Value,
    ) -> Option<String> {
        args.string(&["path", "video-project-path", "videoProjectPath"])
            .or_else(|| payload_string(payload, "videoProjectPath"))
            .or_else(|| payload_string(payload, "path"))
            .or_else(|| {
                args.string(&[
                    "video-project-id",
                    "videoProjectId",
                    "project-id",
                    "projectId",
                ])
            })
            .or_else(|| payload_string(payload, "videoProjectId"))
            .or_else(|| payload_string(payload, "projectId"))
            .filter(|value| !value.trim().is_empty())
    }

    fn resolve_video_project_path(&self, locator: String) -> Result<String, String> {
        let trimmed = locator.trim();
        if trimmed.is_empty() {
            return Err("video project locator is empty".to_string());
        }
        let normalized = normalize_relative_path(trimmed);
        if normalized.contains('/') {
            return Ok(normalized.trim_end_matches(".md").to_string());
        }
        let default_path = normalize_relative_path(&format!("video/{normalized}"));
        let tree = self.call_channel("manuscripts:list", json!({}))?;
        let mut projects = Vec::<Value>::new();
        collect_video_projects(&tree, &mut projects);
        let target_file_name = normalized.clone();
        let matches = projects
            .iter()
            .filter_map(|item| item.get("path").and_then(Value::as_str))
            .map(str::trim)
            .filter(|path| !path.is_empty())
            .filter(|path| {
                *path == default_path
                    || *path == target_file_name
                    || path.ends_with(&format!("/{target_file_name}"))
            })
            .map(ToString::to_string)
            .collect::<Vec<_>>();
        if matches.len() == 1 {
            Ok(matches[0].clone())
        } else {
            Ok(default_path)
        }
    }

    fn collect_subject_matches(
        &self,
        args: &CliArgs,
        payload: &Value,
        limit: usize,
    ) -> Result<Vec<Value>, String> {
        let subject_ids = comma_list_strings(
            args.value(&["subject-ids", "subjectIds"])
                .or_else(|| payload_field(payload, "subjectIds").cloned()),
        );
        if !subject_ids.is_empty() {
            let mut matches = Vec::<Value>::new();
            for id in subject_ids.into_iter().take(limit) {
                let result = self.call_channel("subjects:get", json!({ "id": id }))?;
                if let Some(subject) = result
                    .get("subject")
                    .cloned()
                    .filter(|item| !item.is_null())
                {
                    matches.push(subject);
                }
            }
            return Ok(matches);
        }
        let subject_query = args
            .string(&["subject-query", "query-subjects"])
            .or_else(|| payload_string(payload, "subjectQuery"));
        if let Some(subject_query) = subject_query.filter(|item| !item.trim().is_empty()) {
            let result = self.call_channel("subjects:search", json!({ "query": subject_query }))?;
            return Ok(result
                .get("subjects")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .take(limit)
                .collect());
        }
        Ok(Vec::new())
    }

    fn generated_media_history(&self, kind: &str) -> Result<Value, String> {
        let result = self.call_channel("media:list", json!({}))?;
        let assets = result
            .get("assets")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter(|item| media_matches_kind(item, kind))
            .collect::<Vec<_>>();
        Ok(json!({ "success": true, "assets": assets }))
    }

    fn generated_media_history_get(&self, kind: &str, id: &str) -> Result<Value, String> {
        let result = self.generated_media_history(kind)?;
        let asset = result
            .get("assets")
            .and_then(Value::as_array)
            .and_then(|items| {
                items.iter().find(|item| {
                    item.get("id")
                        .and_then(Value::as_str)
                        .map(|value| value == id)
                        .unwrap_or(false)
                })
            })
            .cloned();
        Ok(json!({ "success": asset.is_some(), "asset": asset }))
    }

    fn call_channel(&self, channel: &str, payload: Value) -> Result<Value, String> {
        let payload = self.payload_with_runtime_context(channel, payload);
        if let Some(result) =
            commands::system::handle_system_channel(self.app, self.state, channel, &payload)
        {
            return result;
        }
        if let Some(result) =
            commands::spaces::handle_spaces_channel(self.app, self.state, channel, &payload)
        {
            return result;
        }
        if let Some(result) =
            commands::subjects::handle_subjects_channel(self.app, self.state, channel, &payload)
        {
            return result;
        }
        if let Some(result) =
            commands::voice::handle_voice_channel(self.app, self.state, channel, &payload)
        {
            return result;
        }
        if let Some(result) =
            commands::advisor_ops::handle_advisor_channel(self.app, self.state, channel, &payload)
        {
            return result;
        }
        if let Some(result) =
            commands::library::handle_library_channel(self.app, self.state, channel, &payload)
        {
            return result;
        }
        if let Some(result) =
            commands::generation::handle_generation_channel(self.app, self.state, channel, &payload)
        {
            return result;
        }
        if let Some(result) =
            commands::media_jobs::handle_media_jobs_channel(self.app, self.state, channel, &payload)
        {
            return result;
        }
        if let Some(result) = commands::workspace_data::handle_workspace_data_channel(
            self.app, self.state, channel, &payload,
        ) {
            return result;
        }
        if let Some(result) = commands::manuscripts::handle_manuscripts_channel(
            self.app, self.state, channel, &payload,
        ) {
            return result;
        }
        if let Some(result) =
            commands::redclaw::handle_redclaw_channel(self.app, self.state, channel, &payload)
        {
            return result;
        }
        if let Some(result) =
            commands::skills_ai::handle_skills_ai_channel(self.app, self.state, channel, &payload)
        {
            return result;
        }
        if let Some(result) =
            commands::mcp_tools::handle_mcp_tools_channel(self.app, self.state, channel, &payload)
        {
            return result;
        }
        if let Some(result) =
            commands::runtime::handle_runtime_channel(self.app, self.state, channel, &payload)
        {
            return result;
        }
        if let Some(result) =
            commands::bridge::handle_bridge_channel(self.app, self.state, channel, &payload)
        {
            return result;
        }
        if let Some(result) = commands::cli_runtime::handle_cli_runtime_channel(
            self.app, self.state, channel, &payload,
        ) {
            return result;
        }
        if let Some(result) = commands::chat_sessions_wander::handle_chat_sessions_wander_channel(
            self.app, self.state, channel, &payload,
        ) {
            return result;
        }
        Err(format!("workflow channel not handled: {channel}"))
    }

    fn payload_with_runtime_context(&self, channel: &str, payload: Value) -> Value {
        if !channel_needs_runtime_context(channel) {
            return payload;
        }
        let Value::Object(mut object) = payload else {
            return payload;
        };
        if let Some(session_id) = self.session_id {
            object
                .entry("sessionId".to_string())
                .or_insert_with(|| json!(session_id));
            object
                .entry("ownerSessionId".to_string())
                .or_insert_with(|| json!(session_id));
        }
        if let Some(tool_call_id) = self.tool_call_id {
            object
                .entry("toolCallId".to_string())
                .or_insert_with(|| json!(tool_call_id));
        }
        Value::Object(object)
    }

    fn bound_writing_session_target(&self) -> Option<BoundWritingSessionTarget> {
        let session_id = self.session_id?;
        with_store(self.state, |store| {
            let metadata = store
                .chat_sessions
                .iter()
                .find(|item| item.id == session_id)
                .and_then(|session| session.metadata.as_ref());
            let Some(metadata) = metadata else {
                return Ok(None);
            };
            let file_path = payload_string(metadata, "associatedPackageFilePath")
                .or_else(|| payload_string(metadata, "associatedFilePath"))
                .unwrap_or_default();
            let draft_type = payload_string(metadata, "associatedPackageKind")
                .or_else(|| payload_string(metadata, "draftType"))
                .map(|value| {
                    if value == "article" {
                        "longform".to_string()
                    } else {
                        value
                    }
                })
                .unwrap_or_else(|| "unknown".to_string());
            if file_path.trim().is_empty() || !matches!(draft_type.as_str(), "longform") {
                return Ok(None);
            }
            Ok(Some(BoundWritingSessionTarget {
                file_path,
                draft_type,
                title: payload_string(metadata, "associatedPackageTitle"),
            }))
        })
        .ok()
        .flatten()
    }

    fn current_authoring_target_preference(&self) -> Option<AuthoringTargetPreference> {
        if let Some(target) = self.current_authoring_session_target() {
            return Some(AuthoringTargetPreference {
                preferred_kind: target.project_kind,
                preferred_subdir: Some(split_parent_and_name(&target.project_path).0),
            });
        }
        if let Some(target) = self.bound_writing_session_target() {
            let draft_type = target.draft_type.to_ascii_lowercase();
            let preferred_kind = match draft_type.as_str() {
                "longform" => AuthoringProjectKind::Redarticle,
                _ => return None,
            };
            return Some(AuthoringTargetPreference {
                preferred_kind,
                preferred_subdir: None,
            });
        }

        let session_id = self.session_id?;
        with_store(self.state, |store| {
            let metadata = store
                .chat_sessions
                .iter()
                .find(|item| item.id == session_id)
                .and_then(|session| session.metadata.as_ref());
            let Some(metadata) = metadata else {
                return Ok(None);
            };
            let intent = payload_string(metadata, "intent")
                .or_else(|| {
                    metadata
                        .get("taskHints")
                        .and_then(|value| payload_string(value, "intent"))
                })
                .unwrap_or_default();
            if intent != "manuscript_creation" {
                return Ok(None);
            }
            let platform = payload_string(metadata, "platform").or_else(|| {
                metadata
                    .get("taskHints")
                    .and_then(|value| payload_string(value, "platform"))
            });
            let preferred_subdir = payload_string(metadata, "saveSubdir")
                .or_else(|| {
                    metadata
                        .get("taskHints")
                        .and_then(|value| payload_string(value, "saveSubdir"))
                })
                .or_else(|| {
                    let context_type = payload_string(metadata, "contextType").unwrap_or_default();
                    if context_type == "wander" {
                        Some("wander".to_string())
                    } else {
                        None
                    }
                });
            let preference = match platform.as_deref() {
                Some("wechat_official_account") => AuthoringTargetPreference {
                    preferred_kind: AuthoringProjectKind::Redarticle,
                    preferred_subdir,
                },
                Some("xiaohongshu") => AuthoringTargetPreference {
                    preferred_kind: AuthoringProjectKind::Redpost,
                    preferred_subdir,
                },
                _ => AuthoringTargetPreference {
                    preferred_kind: AuthoringProjectKind::Redpost,
                    preferred_subdir,
                },
            };
            Ok(Some(preference))
        })
        .ok()
        .flatten()
    }

    fn current_authoring_session_target(&self) -> Option<CurrentAuthoringSessionTarget> {
        let session_id = self.session_id?;
        with_store(self.state, |store| {
            let metadata = store
                .chat_sessions
                .iter()
                .find(|item| item.id == session_id)
                .and_then(|session| session.metadata.as_ref());
            let Some(metadata) = metadata else {
                return Ok(None);
            };
            let project_path =
                payload_string(metadata, "currentAuthoringProjectPath").unwrap_or_default();
            let content_path =
                payload_string(metadata, "currentAuthoringContentPath").unwrap_or_default();
            if project_path.trim().is_empty() || content_path.trim().is_empty() {
                return Ok(None);
            }
            let project_kind = authoring_project_kind_from_value(
                payload_string(metadata, "currentAuthoringProjectKind").as_deref(),
            )
            .unwrap_or(AuthoringProjectKind::Redpost);
            Ok(Some(CurrentAuthoringSessionTarget {
                project_path,
                project_kind,
            }))
        })
        .ok()
        .flatten()
    }

    fn active_session_skills(&self) -> Vec<LoadedSkillRecord> {
        let Some(session_id) = self.session_id else {
            return Vec::new();
        };
        with_store(self.state, |store| {
            let metadata = store
                .chat_sessions
                .iter()
                .find(|item| item.id == session_id)
                .and_then(|session| session.metadata.as_ref());
            let Some(metadata) = metadata else {
                return Ok(Vec::new());
            };
            Ok(
                resolve_skill_set(&store.skills, self.runtime_mode, Some(metadata), &[])
                    .active_skills,
            )
        })
        .unwrap_or_default()
    }

    fn load_skill_host_save_validators(
        &self,
        skill: &LoadedSkillRecord,
    ) -> Result<Option<SkillHostSaveValidatorSet>, String> {
        let workspace = workspace_root(self.state).ok();
        let bundle = load_skill_bundle_sections_from_sources(&skill.name, workspace.as_deref());
        let Some(raw_rules) = bundle.rules.get("host-save-validators.json") else {
            return Ok(None);
        };
        let parsed =
            serde_json::from_str::<SkillHostSaveValidatorSet>(raw_rules).map_err(|error| {
                format!(
                    "技能 {} 的 host-save-validators.json 无法解析：{error}",
                    skill.name
                )
            })?;
        Ok(Some(parsed))
    }

    fn validate_authoring_save_content(
        &self,
        project_kind: Option<AuthoringProjectKind>,
        content: &str,
    ) -> Result<(), String> {
        if content.trim().is_empty() {
            return Ok(());
        }
        if !matches!(
            project_kind,
            Some(AuthoringProjectKind::Redpost | AuthoringProjectKind::Redarticle)
        ) {
            return Ok(());
        }
        let project_kind = project_kind.expect("project kind should exist after match");
        let project_kind_label = authoring_project_kind_label(project_kind);
        let mut violations = Vec::<String>::new();
        for skill in self.active_session_skills() {
            let Some(validators) = self.load_skill_host_save_validators(&skill)? else {
                continue;
            };
            if !validators.applies_to.is_empty()
                && !validators
                    .applies_to
                    .iter()
                    .any(|value| value.eq_ignore_ascii_case(project_kind_label))
            {
                continue;
            }
            for rule in validators
                .rules
                .iter()
                .filter(|rule| !rule.message.trim().is_empty())
            {
                if evaluate_skill_host_save_rule(rule, content) {
                    violations.push(format!("{}: {}", skill.name, rule.message.trim()));
                }
            }
        }
        if violations.is_empty() {
            return Ok(());
        }
        Err(format!(
            "保存前校验未通过：{}。请先修正文案后再保存。",
            violations.join("；")
        ))
    }

    fn persist_current_authoring_session_target(
        &self,
        project_path: &str,
        content_path: &str,
        entry_path: &str,
        project_kind: AuthoringProjectKind,
        title: &str,
    ) -> Result<(), String> {
        let Some(session_id) = self.session_id else {
            return Ok(());
        };
        with_store_mut(self.state, |store| {
            let Some(session) = store
                .chat_sessions
                .iter_mut()
                .find(|item| item.id == session_id)
            else {
                return Ok(());
            };
            let mut metadata = session
                .metadata
                .clone()
                .and_then(|value| value.as_object().cloned())
                .unwrap_or_default();
            metadata.insert(
                "currentAuthoringProjectPath".to_string(),
                json!(project_path),
            );
            metadata.insert(
                "currentAuthoringContentPath".to_string(),
                json!(content_path),
            );
            metadata.insert("currentAuthoringEntryPath".to_string(), json!(entry_path));
            metadata.insert(
                "currentAuthoringProjectKind".to_string(),
                json!(authoring_project_kind_label(project_kind)),
            );
            metadata.insert("currentAuthoringTitle".to_string(), json!(title));
            session.metadata = Some(Value::Object(metadata));
            session.updated_at = now_iso();
            Ok(())
        })?;
        emit_runtime_task_checkpoint_saved(
            self.app,
            None,
            Some(session_id),
            "chat.authoring_target_bound",
            "authoring target bound",
            Some(json!({
                "projectPath": project_path,
                "contentPath": content_path,
                "entryPath": entry_path,
                "kind": authoring_project_kind_label(project_kind),
                "title": title,
            })),
        );
        Ok(())
    }

    fn default_authoring_project_kind(&self) -> AuthoringProjectKind {
        let Some(preference) = self.current_authoring_target_preference() else {
            return AuthoringProjectKind::Redpost;
        };
        preference.preferred_kind
    }

    fn handle_manuscript_create_project(
        &self,
        args: &CliArgs,
        payload: &Value,
    ) -> Result<Value, String> {
        let title = payload_string(payload, "title")
            .or_else(|| args.string(&["title"]))
            .or_else(|| args.positionals.first().cloned())
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "manuscripts create-project requires --title".to_string())?;
        let requested_parent = payload_string(payload, "parent")
            .or_else(|| payload_string(payload, "parentPath"))
            .or_else(|| args.string(&["parent", "parent-path", "parentPath"]));
        let project_kind = authoring_project_kind_from_value(
            payload_string(payload, "kind")
                .or_else(|| args.string(&["kind"]))
                .as_deref(),
        )
        .unwrap_or_else(|| self.default_authoring_project_kind());
        let project_id = build_authoring_project_id(&title, project_kind);
        let preferred_subdir = self
            .current_authoring_target_preference()
            .and_then(|preference| preference.preferred_subdir);
        let normalized_parent = requested_parent
            .map(|value| normalize_relative_path(&value))
            .filter(|value| !value.trim().is_empty())
            .or(preferred_subdir)
            .unwrap_or_default();
        let relative = build_authoring_project_relative_path(
            Some(&normalized_parent),
            &project_id,
            project_kind,
        );
        let (parent_path, name) = split_parent_and_name(&relative);
        let created = self.call_channel(
            "manuscripts:create-file",
            json!({
                "parentPath": parent_path,
                "name": name,
                "kind": authoring_project_kind_label(project_kind),
                "title": title,
                "content": ""
            }),
        )?;
        let entry_name = match project_kind {
            AuthoringProjectKind::Redpost | AuthoringProjectKind::Redarticle => "content.md",
        };
        let content_path = join_relative(&relative, entry_name);
        self.persist_current_authoring_session_target(
            &relative,
            &content_path,
            &content_path,
            project_kind,
            &title,
        )?;
        Ok(json!({
            "success": created.get("success").and_then(Value::as_bool).unwrap_or(true),
            "path": created.get("path").cloned().unwrap_or_else(|| json!(relative.clone())),
            "projectPath": created.get("path").cloned().unwrap_or_else(|| json!(relative.clone())),
            "contentPath": content_path.clone(),
            "entryPath": content_path,
            "projectId": project_id,
            "title": title,
            "kind": authoring_project_kind_label(project_kind),
        }))
    }

    fn handle_manuscript_write_current(&self, payload: &Value) -> Result<Value, String> {
        let target = self.current_authoring_session_target().ok_or_else(|| {
            "manuscripts write-current requires an active authoring project".to_string()
        })?;
        let mut merged = payload.clone();
        let content = payload_string(&merged, "content").unwrap_or_default();
        if content.trim().is_empty() {
            return Err(json!({
                "ok": false,
                "tool": "workflow",
                "action": "manuscripts.writeCurrent",
                "error": {
                    "code": "EMPTY_CONTENT_REJECTED",
                    "message": "manuscripts.writeCurrent requires non-empty content; use Write(path=\"manuscripts://current\", content=\"完整正文\")",
                    "retryable": false
                }
            })
            .to_string());
        }
        let object = merged
            .as_object_mut()
            .ok_or_else(|| "manuscripts write-current payload must be an object".to_string())?;
        object.insert("path".to_string(), json!(target.project_path.clone()));
        object
            .entry("content".to_string())
            .or_insert(json!(content));
        self.validate_authoring_save_content(
            Some(target.project_kind),
            &payload_string(&merged, "content").unwrap_or_default(),
        )?;
        let content = payload_string(&merged, "content").unwrap_or_default();
        if let Some(result) = self.maybe_queue_writing_manuscript_proposal(
            &target.project_path,
            content,
            payload_field(&merged, "metadata"),
        )? {
            return Ok(result);
        }
        let saved = self.call_channel("manuscripts:save", merged.clone())?;
        let saved_bytes = payload_string(&merged, "content")
            .map(|value| value.as_bytes().len() as i64)
            .unwrap_or(0);
        let project_path = target.project_path.clone();
        let content_path = join_relative(&project_path, "content.md");
        Ok(json!({
            "projectPath": project_path,
            "contentPath": content_path,
            "savedBytes": saved_bytes,
            "result": saved,
        }))
    }

    fn handle_manuscript_read_current(&self) -> Result<Value, String> {
        let target = self.current_authoring_session_target().ok_or_else(|| {
            "manuscripts read-current requires an active authoring project".to_string()
        })?;
        self.call_channel("manuscripts:read", json!(target.project_path))
    }

    fn normalize_manuscript_target_path(&self, requested_path: &str) -> String {
        let normalized = normalize_relative_path(requested_path);
        if normalized.trim().is_empty() {
            return normalized;
        }
        let Some(preference) = self.current_authoring_target_preference() else {
            return if normalized.ends_with(".md") {
                normalized
            } else {
                format!("{normalized}.md")
            };
        };
        let normalized =
            normalize_authoring_target_subdir(&normalized, preference.preferred_subdir.as_deref());
        let resolved = resolve_manuscript_path(self.state, &normalized).ok();
        let target_exists = resolved.as_ref().map(|path| path.exists()).unwrap_or(false);
        if normalized.ends_with(".md") {
            if target_exists {
                return normalized;
            }
            let stem = normalized.trim_end_matches(".md");
            return stem.to_string();
        }
        if target_exists {
            return normalized;
        }
        normalized
    }

    fn maybe_queue_writing_manuscript_proposal(
        &self,
        target_path: &str,
        content: String,
        metadata: Option<&Value>,
    ) -> Result<Option<Value>, String> {
        let Some(target) = self.bound_writing_session_target() else {
            return Ok(None);
        };
        let normalized_target_path = normalize_relative_path(target_path);
        if normalize_relative_path(&target.file_path) != normalized_target_path {
            return Ok(None);
        }
        let current =
            self.call_channel("manuscripts:read", json!(normalized_target_path.clone()))?;
        let current_content = payload_string(&current, "content").unwrap_or_default();
        let frontmatter_block = extract_markdown_frontmatter_block(&current_content);
        let proposed_body = strip_markdown_frontmatter(&content);
        let proposed_content =
            compose_markdown_with_frontmatter(&proposed_body, frontmatter_block.as_deref());
        if proposed_content == current_content {
            return Ok(Some(json!({
                "success": true,
                "proposalCreated": false,
                "unchanged": true,
                "filePath": normalized_target_path,
                "message": "AI 返回的稿件与当前内容一致，没有生成新的改稿提案。"
            })));
        }
        let timestamp = now_iso();
        let proposal = crate::ManuscriptWriteProposalRecord {
            id: make_id("manuscript-proposal"),
            file_path: normalized_target_path.clone(),
            session_id: self.session_id.map(ToString::to_string),
            tool_call_id: self.tool_call_id.map(ToString::to_string),
            draft_type: Some(target.draft_type),
            title: target.title,
            metadata: metadata.cloned(),
            base_content: current_content,
            proposed_content,
            created_at: timestamp.clone(),
            updated_at: timestamp,
        };
        let saved = commands::manuscripts::upsert_manuscript_write_proposal(
            self.app, self.state, proposal,
        )?;
        Ok(Some(json!({
            "success": true,
            "proposalCreated": true,
            "requiresReview": true,
            "filePath": saved.file_path,
            "proposal": saved,
            "message": "已生成待审改稿提案。请在稿件编辑器里查看 diff，并手动接受或拒绝。"
        })))
    }
}

fn parse_cli_args(tokens: &[String]) -> Result<CliArgs, String> {
    let mut args = CliArgs::default();
    let mut index = 0usize;
    while index < tokens.len() {
        let token = &tokens[index];
        if let Some(stripped) = token.strip_prefix("--") {
            if stripped.is_empty() {
                return Err("invalid empty option".to_string());
            }
            if let Some((key, value)) = stripped.split_once('=') {
                args.options
                    .insert(key.to_string(), parse_option_value(value));
                index += 1;
                continue;
            }
            let next = tokens.get(index + 1);
            if let Some(value) = next.filter(|item| !item.starts_with("--")) {
                args.options
                    .insert(stripped.to_string(), parse_option_value(value));
                index += 2;
                continue;
            }
            args.options.insert(stripped.to_string(), Value::Bool(true));
            index += 1;
            continue;
        }
        args.positionals.push(token.clone());
        index += 1;
    }
    Ok(args)
}

fn tokenize_command(input: &str) -> Vec<String> {
    let mut tokens = Vec::<String>::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut chars = input.trim().chars().peekable();
    while let Some(ch) = chars.next() {
        if let Some(active_quote) = quote {
            match ch {
                '\\' => {
                    if let Some(next) = chars.next() {
                        if next == active_quote || next == '\\' {
                            current.push(next);
                        } else {
                            current.push(ch);
                            current.push(next);
                        }
                    } else {
                        current.push(ch);
                    }
                }
                value if value == active_quote => quote = None,
                value => current.push(value),
            }
            continue;
        }

        match ch {
            '"' | '\'' => quote = Some(ch),
            value if value.is_whitespace() => {
                if !current.is_empty() {
                    tokens.push(std::mem::take(&mut current));
                }
            }
            '\\' => {
                if let Some(next) = chars.next() {
                    current.push(next);
                } else {
                    current.push(ch);
                }
            }
            value => current.push(value),
        }
    }

    if !current.is_empty() {
        tokens.push(current);
    }
    tokens
}

fn preflight_skill_activation_item(
    skills: &[SkillRecord],
    runtime_mode: &str,
    skill_name: &str,
) -> Option<(String, String)> {
    let skill = find_catalog_skill_by_name(skills, skill_name)?;
    if skill.disabled || !skill_allows_runtime_mode(&skill, runtime_mode) {
        return None;
    }
    Some((skill.name, skill.description))
}

fn parse_option_value(raw: &str) -> Value {
    let trimmed = raw.trim();
    match trimmed.to_ascii_lowercase().as_str() {
        "true" => Value::Bool(true),
        "false" => Value::Bool(false),
        _ => {
            if let Ok(value) = trimmed.parse::<i64>() {
                return json!(value);
            }
            if let Ok(value) = trimmed.parse::<f64>() {
                if value.is_finite() {
                    return json!(value);
                }
            }
            Value::String(trimmed.to_string())
        }
    }
}

fn merge_payload(options: &Map<String, Value>, payload: &Value) -> Value {
    let mut merged = options.clone();
    if let Some(payload_object) = payload.as_object() {
        for (key, value) in payload_object {
            merged.insert(key.clone(), value.clone());
        }
    }
    Value::Object(merged)
}

fn merge_mcp_target_payload(
    args: &CliArgs,
    payload: &Value,
    missing_message: &str,
) -> Result<Value, String> {
    let mut request = merge_payload(&args.options, payload);
    if let Some(object) = request.as_object_mut() {
        if !object.contains_key("serverId")
            && !object.contains_key("id")
            && !object.contains_key("name")
        {
            let target = args
                .positionals
                .first()
                .cloned()
                .ok_or_else(|| missing_message.to_string())?;
            object.insert("serverId".to_string(), Value::String(target));
        }
    }
    Ok(request)
}

fn memory_action_request(
    action: &str,
    args: &CliArgs,
    payload: &Value,
) -> Result<(&'static str, Value), String> {
    match action {
        "list" => Ok(("memory:list", json!({}))),
        "search" => Ok(("memory:search", memory_query_payload(args, payload))),
        "recall" => Ok(("memory:recall", memory_query_payload(args, payload))),
        "add" => Ok(("memory:add", merge_payload(&args.options, payload))),
        "update" => Ok(("memory:update", merge_payload(&args.options, payload))),
        "archive" => Ok(("memory:archive", merge_payload(&args.options, payload))),
        "delete" => Ok((
            "memory:delete",
            json!(args
                .string(&["id"])
                .or_else(|| args.positionals.first().cloned())
                .ok_or_else(|| "memory delete requires --id".to_string())?),
        )),
        "rebuild-index" | "rebuildIndex" => Ok(("memory:rebuild-index", json!({}))),
        "diagnostics" => Ok(("memory:diagnostics", json!({}))),
        _ => Err(format!("unsupported memory action: {action}")),
    }
}

fn memory_query_payload(args: &CliArgs, payload: &Value) -> Value {
    let mut merged = payload
        .as_object()
        .cloned()
        .unwrap_or_else(Map::<String, Value>::new);
    let query = args
        .string(&["query", "q"])
        .or_else(|| payload_string(payload, "query"))
        .or_else(|| {
            if args.positionals.is_empty() {
                None
            } else {
                Some(args.positionals.join(" "))
            }
        })
        .unwrap_or_default();
    merged.insert("query".to_string(), json!(query));
    for (key, value) in &args.options {
        merged.insert(key.clone(), value.clone());
    }
    Value::Object(merged)
}

fn build_generation_payload(args: &CliArgs, payload: &Value) -> Value {
    let mut merged = payload
        .as_object()
        .cloned()
        .unwrap_or_else(Map::<String, Value>::new);
    let prompt = args.string(&["prompt"]).or_else(|| {
        if args.positionals.is_empty() {
            None
        } else {
            Some(args.positionals.join(" "))
        }
    });
    copy_optional_string(&mut merged, "prompt", prompt);
    copy_optional_string(&mut merged, "title", args.string(&["title"]));
    copy_optional_string(&mut merged, "provider", args.string(&["provider"]));
    copy_optional_string(
        &mut merged,
        "providerTemplate",
        args.string(&["provider-template", "providerTemplate"]),
    );
    copy_optional_string(&mut merged, "model", args.string(&["model"]));
    copy_optional_string(
        &mut merged,
        "aspectRatio",
        args.string(&["aspect-ratio", "aspectRatio"]),
    );
    copy_optional_string(&mut merged, "size", args.string(&["size"]));
    copy_optional_string(&mut merged, "quality", args.string(&["quality"]));
    copy_optional_string(
        &mut merged,
        "projectId",
        args.string(&[
            "project-id",
            "projectId",
            "video-project-id",
            "videoProjectId",
        ]),
    );
    copy_optional_string(
        &mut merged,
        "generationMode",
        args.string(&["generation-mode", "generationMode", "mode"]),
    );
    copy_optional_string(
        &mut merged,
        "resolution",
        args.string(&["resolution", "image-resolution", "imageResolution", "size"]),
    );
    copy_optional_string(
        &mut merged,
        "drivingAudio",
        args.string(&["driving-audio", "audio-url", "drivingAudio"]),
    );
    copy_optional_string(
        &mut merged,
        "firstClip",
        args.string(&["first-clip", "video-url", "firstClip"]),
    );
    copy_optional_string(
        &mut merged,
        "subjectQuery",
        args.string(&["subject-query", "query-subjects", "subjectQuery"]),
    );
    if let Some(count) = args.i64(&["count"]) {
        merged.insert("count".to_string(), json!(count));
    }
    if let Some(duration_seconds) = args.i64(&["duration", "seconds", "durationSeconds"]) {
        merged.insert("durationSeconds".to_string(), json!(duration_seconds));
    }
    if let Some(generate_audio) = args.bool(&["audio", "generate-audio", "generateAudio"]) {
        merged.insert("generateAudio".to_string(), json!(generate_audio));
    }
    if let Some(subject_ids) = comma_list_value(args.value(&["subject-ids", "subjectIds"])) {
        merged.insert("subjectIds".to_string(), subject_ids);
    }
    if let Some(reference_images) =
        comma_list_value(args.value(&["reference-images", "referenceImages", "images"]))
    {
        merged.insert("referenceImages".to_string(), reference_images);
    }
    if !merged.contains_key("referenceImages") {
        if let Some(images) = payload_field(payload, "images").cloned() {
            merged.insert("referenceImages".to_string(), images);
        }
    }
    if !merged.contains_key("generationMode") {
        if let Some(mode) = payload_string(payload, "mode").filter(|item| !item.trim().is_empty()) {
            merged.insert("generationMode".to_string(), json!(mode));
        }
    }
    if !merged.contains_key("aspectRatio") {
        if let Some(ratio) = payload_string(payload, "ratio").filter(|item| !item.trim().is_empty())
        {
            merged.insert("aspectRatio".to_string(), json!(ratio));
        }
    }
    if let Some(normalized_ratio) = merged
        .get("aspectRatio")
        .and_then(Value::as_str)
        .and_then(normalize_image_aspect_ratio_alias)
    {
        merged.insert("aspectRatio".to_string(), json!(normalized_ratio));
    }
    if !merged.contains_key("durationSeconds") {
        let duration_seconds = payload_field(payload, "duration")
            .and_then(|value| match value {
                Value::Number(number) => number.as_i64(),
                Value::String(text) => text.trim().parse::<i64>().ok(),
                _ => None,
            })
            .or_else(|| {
                payload_field(payload, "seconds").and_then(|value| match value {
                    Value::Number(number) => number.as_i64(),
                    Value::String(text) => text.trim().parse::<i64>().ok(),
                    _ => None,
                })
            });
        if let Some(duration_seconds) = duration_seconds {
            merged.insert("durationSeconds".to_string(), json!(duration_seconds));
        }
    }
    if !merged.contains_key("projectId") {
        if let Some(value) = merged
            .get("videoProjectId")
            .cloned()
            .or_else(|| merged.get("video-project-id").cloned())
        {
            merged.insert("projectId".to_string(), value);
        }
    }
    Value::Object(merged)
}

fn normalize_image_aspect_ratio_alias(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    let normalized = trimmed
        .replace('：', ":")
        .replace('×', "x")
        .replace('*', "x")
        .to_ascii_lowercase();
    let compact = normalized
        .chars()
        .filter(|ch| !ch.is_whitespace())
        .collect::<String>();
    match compact.as_str() {
        "1:1" | "square" => return Some("1:1".to_string()),
        "3:4" | "portrait" | "verticalcard" => return Some("3:4".to_string()),
        "4:3" | "landscape" => return Some("4:3".to_string()),
        "9:16" | "story" | "reels" | "shorts" => return Some("9:16".to_string()),
        "16:9" | "wide" | "widescreen" => return Some("16:9".to_string()),
        _ => {}
    }
    if compact.contains("正方") || compact.contains("方图") {
        return Some("1:1".to_string());
    }
    if compact.contains("小红书")
        || compact.contains("竖图")
        || compact.contains("竖版")
        || compact.contains("肖像")
    {
        return Some("3:4".to_string());
    }
    if compact.contains("横图") || compact.contains("横版") || compact.contains("风景") {
        return Some("4:3".to_string());
    }
    None
}

fn comma_list_value(value: Option<Value>) -> Option<Value> {
    match value {
        Some(Value::Array(items)) => Some(Value::Array(items)),
        Some(Value::String(text)) => {
            let items = text
                .split(',')
                .map(str::trim)
                .filter(|item| !item.is_empty())
                .map(|item| json!(item))
                .collect::<Vec<_>>();
            Some(json!(items))
        }
        _ => None,
    }
}

fn comma_list_strings(value: Option<Value>) -> Vec<String> {
    match value {
        Some(Value::Array(items)) => items
            .into_iter()
            .filter_map(|item| item.as_str().map(str::trim).map(ToString::to_string))
            .filter(|item| !item.is_empty())
            .collect(),
        Some(Value::String(text)) => text
            .split(',')
            .map(str::trim)
            .filter(|item| !item.is_empty())
            .map(ToString::to_string)
            .collect(),
        _ => Vec::new(),
    }
}

fn value_string_list(value: Option<&Value>, limit: usize) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|item| !item.is_empty())
                .take(limit)
                .map(ToString::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

fn dedupe_string_list(items: &mut Vec<String>, limit: usize) {
    let mut deduped = Vec::<String>::new();
    for item in items.drain(..) {
        if !deduped.contains(&item) {
            deduped.push(item);
        }
        if deduped.len() >= limit {
            break;
        }
    }
    *items = deduped;
}

fn image_plan_item_field(value: &Value, keys: &[&str]) -> String {
    keys.iter()
        .find_map(|key| value.get(*key))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .map(ToString::to_string)
        .unwrap_or_default()
}

fn extract_image_plan_items(value: Option<&Value>) -> Vec<ImageGenerationPlanItem> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter(|item| item.is_object())
                .map(|item| ImageGenerationPlanItem {
                    title: image_plan_item_field(item, &["title", "name", "label"]),
                    prompt: image_plan_item_field(
                        item,
                        &["prompt", "visual", "description", "picture", "goal"],
                    ),
                    copy: image_plan_item_field(
                        item,
                        &["copy", "caption", "overlayText", "textDetail"],
                    ),
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

fn requested_image_generation_count(payload: &Value, image_plan_len: usize) -> usize {
    if image_plan_len > 0 {
        return image_plan_len.clamp(1, MAX_IMAGE_BATCH_ITEMS);
    }
    payload_field(payload, "count")
        .and_then(Value::as_i64)
        .unwrap_or(1)
        .clamp(1, MAX_IMAGE_BATCH_ITEMS as i64) as usize
}

fn image_generation_delivery_mode(
    session_id: Option<&str>,
    payload: &Value,
    requested_count: usize,
) -> ImageGenerationDeliveryMode {
    let explicit_wait_for_completion = payload_field(payload, "waitForCompletion")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if session_id.is_some() && requested_count > 1 {
        return ImageGenerationDeliveryMode::BackgroundFollowup;
    }
    if explicit_wait_for_completion || (session_id.is_some() && requested_count == 1) {
        return ImageGenerationDeliveryMode::InlineWait;
    }
    ImageGenerationDeliveryMode::AsyncSubmit
}

fn apply_agent_image_generation_defaults(payload: &mut Value) {
    let Some(object) = payload.as_object_mut() else {
        return;
    };
    if object
        .get("quality")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .is_none()
    {
        object.insert("quality".to_string(), json!("low"));
    }
    if object
        .get("resolution")
        .or_else(|| object.get("imageResolution"))
        .or_else(|| object.get("image_resolution"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .is_none()
    {
        object.insert("resolution".to_string(), json!("1K"));
    }
}

fn video_generation_should_wait(session_id: Option<&str>, payload: &Value) -> bool {
    if let Some(explicit_wait) = payload_bool(payload, &["waitForCompletion"]) {
        return explicit_wait;
    }
    if payload_bool(
        payload,
        &[
            "backgroundFollowup",
            "background",
            "asyncSubmit",
            "submitOnly",
        ],
    )
    .unwrap_or(false)
    {
        return false;
    }
    session_id.is_some()
}

fn compile_image_batch_prompt(
    base_prompt: &str,
    shared_style_guide: Option<&str>,
    item: &ImageGenerationPlanItem,
    index: usize,
    total: usize,
) -> String {
    let mut sections = Vec::<String>::new();
    let trimmed_brief = compact_whitespace(base_prompt);
    if !trimmed_brief.is_empty() {
        sections.push(format!("整组创意任务：{trimmed_brief}"));
    }
    sections.push(format!(
        "这是同一组连续视觉中的第 {}/{} 张图片。",
        index + 1,
        total
    ));
    if !item.title.trim().is_empty() {
        sections.push(format!("本张标题：{}", compact_whitespace(&item.title)));
    }
    sections.push(format!(
        "本张画面目标：{}",
        compact_whitespace(&item.prompt)
    ));
    if !item.copy.trim().is_empty() {
        sections.push(format!("本张文案细节：{}", compact_whitespace(&item.copy)));
    }
    if let Some(shared_style_guide) = shared_style_guide
        .map(compact_whitespace)
        .filter(|item| !item.is_empty())
    {
        sections.push(format!("全组统一风格锚点：{shared_style_guide}"));
    }
    sections.push(
        "跨图一致性要求：保持同一主体身份、服装与材质逻辑、色彩系统、光线方向、镜头语言和画面完成度，不要把这一张单独做成另一套风格。"
            .to_string(),
    );
    sections.join("\n")
}

fn compact_whitespace(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn normalize_storyboard_cell(text: &str) -> String {
    compact_whitespace(
        &text
            .replace("<br />", " / ")
            .replace("<br/>", " / ")
            .replace("<br>", " / "),
    )
    .trim()
    .trim_matches('`')
    .to_string()
}

fn payload_string_alias(payload: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| payload_string(payload, key))
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn subject_id_from_args_or_payload(args: &CliArgs, payload: &Value) -> Option<String> {
    args.string(&["id"])
        .or_else(|| payload_string_alias(payload, &["id", "assetId", "subjectId"]))
        .or_else(|| args.positionals.first().cloned())
}

fn subject_query_from_args_or_payload(args: &CliArgs, payload: &Value) -> Option<String> {
    args.string(&["query", "q"])
        .or_else(|| payload_string_alias(payload, &["query", "q", "name"]))
        .or_else(|| {
            if args.positionals.is_empty() {
                None
            } else {
                Some(args.positionals.join(" "))
            }
        })
}

fn subject_category_from_args_or_payload(args: &CliArgs, payload: &Value) -> Option<String> {
    args.string(&["category-id", "category"])
        .or_else(|| payload_string_alias(payload, &["categoryId", "category-id", "category"]))
}

fn skill_name_from_args_or_payload(args: &CliArgs, payload: &Value) -> Option<String> {
    args.string(&["name"])
        .or_else(|| payload_string_alias(payload, &["name", "skillName"]))
        .or_else(|| args.positionals.first().cloned())
}

fn storyboard_header_kind(header: &str) -> Option<&'static str> {
    let normalized = header.trim().to_ascii_lowercase();
    if normalized.contains("time") || header.contains("时间") {
        return Some("time");
    }
    if normalized.contains("picture") || normalized.contains("visual") || header.contains("画面")
    {
        return Some("picture");
    }
    if normalized.contains("sound") || normalized.contains("audio") || header.contains("声音") {
        return Some("sound");
    }
    if normalized.contains("shot")
        || normalized.contains("camera")
        || header.contains("景别")
        || header.contains("镜头")
    {
        return Some("shot");
    }
    None
}

fn markdown_separator_row(cells: &[String]) -> bool {
    !cells.is_empty()
        && cells.iter().all(|cell| {
            let trimmed = cell.trim();
            !trimmed.is_empty()
                && trimmed
                    .chars()
                    .all(|ch| ch == '-' || ch == ':' || ch == ' ' || ch == '|' || ch == '\t')
        })
}

fn shot_from_storyboard_map(values: &Map<String, Value>) -> Option<VideoStoryboardShot> {
    let get = |keys: &[&str]| {
        keys.iter()
            .find_map(|key| values.get(*key))
            .and_then(Value::as_str)
            .map(normalize_storyboard_cell)
            .filter(|value| !value.is_empty())
    };
    let shot = VideoStoryboardShot {
        time: get(&["time", "Time", "时间"])?,
        picture: get(&["picture", "Picture", "visual", "Visual", "画面"])?,
        sound: get(&["sound", "Sound", "audio", "Audio", "声音"])
            .unwrap_or_else(|| "未指定".to_string()),
        shot: get(&["shot", "Shot", "camera", "Camera", "景别", "镜头"])
            .unwrap_or_else(|| "未指定".to_string()),
    };
    Some(shot)
}

fn extract_storyboard_shots_from_value(value: &Value) -> Vec<VideoStoryboardShot> {
    match value {
        Value::Array(items) => items
            .iter()
            .filter_map(|item| item.as_object().and_then(shot_from_storyboard_map))
            .collect(),
        Value::String(text) => parse_storyboard_markdown(text),
        Value::Object(values) => shot_from_storyboard_map(values).into_iter().collect(),
        _ => Vec::new(),
    }
}

fn parse_storyboard_markdown(markdown: &str) -> Vec<VideoStoryboardShot> {
    let mut header_kinds = Vec::<&'static str>::new();
    let mut shots = Vec::<VideoStoryboardShot>::new();

    for line in markdown.lines() {
        let trimmed = line.trim();
        if !trimmed.starts_with('|') || !trimmed.ends_with('|') {
            continue;
        }
        let cells = trimmed
            .trim_matches('|')
            .split('|')
            .map(normalize_storyboard_cell)
            .collect::<Vec<_>>();
        if cells.is_empty() {
            continue;
        }
        if header_kinds.is_empty() {
            let mapped = cells
                .iter()
                .filter_map(|cell| storyboard_header_kind(cell))
                .collect::<Vec<_>>();
            if mapped.len() == cells.len()
                && mapped.iter().any(|kind| *kind == "time")
                && mapped.iter().any(|kind| *kind == "picture")
            {
                header_kinds = mapped;
            }
            continue;
        }
        if markdown_separator_row(&cells) {
            continue;
        }
        if cells.len() < header_kinds.len() {
            continue;
        }
        let mut shot = VideoStoryboardShot::default();
        for (index, kind) in header_kinds.iter().enumerate() {
            let value = cells.get(index).cloned().unwrap_or_default();
            match *kind {
                "time" => shot.time = value,
                "picture" => shot.picture = value,
                "sound" => shot.sound = value,
                "shot" => shot.shot = value,
                _ => {}
            }
        }
        if shot.time.is_empty() || shot.picture.is_empty() {
            continue;
        }
        if shot.sound.is_empty() {
            shot.sound = "未指定".to_string();
        }
        if shot.shot.is_empty() {
            shot.shot = "未指定".to_string();
        }
        shots.push(shot);
    }

    shots
}

fn confirmed_project_storyboard(project_state: &Value) -> Vec<VideoStoryboardShot> {
    let status = project_state
        .pointer("/project/scriptApproval/status")
        .or_else(|| project_state.pointer("/scriptApproval/status"))
        .and_then(Value::as_str)
        .unwrap_or("pending");
    if status != "confirmed" {
        return Vec::new();
    }
    let script_body = project_state
        .pointer("/project/scriptBody")
        .or_else(|| project_state.get("scriptBody"))
        .and_then(Value::as_str)
        .unwrap_or("");
    parse_storyboard_markdown(script_body)
}

fn extract_video_storyboard(
    payload: &Value,
    project_state: Option<&Value>,
) -> Vec<VideoStoryboardShot> {
    for key in [
        "storyboardShots",
        "storyboard",
        "storyboardMarkdown",
        "approvedScript",
        "scriptMarkdown",
        "script",
    ] {
        let shots = payload_field(payload, key)
            .map(extract_storyboard_shots_from_value)
            .unwrap_or_default();
        if !shots.is_empty() {
            return shots;
        }
    }
    if let Some(state) = project_state {
        let shots = confirmed_project_storyboard(state);
        if !shots.is_empty() {
            return shots;
        }
    }
    payload_string(payload, "prompt")
        .map(|prompt| parse_storyboard_markdown(&prompt))
        .unwrap_or_default()
}

fn parse_storyboard_time_numbers(value: &str) -> Vec<f64> {
    let mut numbers = Vec::<f64>::new();
    let mut current = String::new();
    for ch in value.chars() {
        if ch.is_ascii_digit() || ch == '.' {
            current.push(ch);
        } else if !current.is_empty() {
            if let Ok(number) = current.parse::<f64>() {
                numbers.push(number);
            }
            current.clear();
        }
    }
    if !current.is_empty() {
        if let Ok(number) = current.parse::<f64>() {
            numbers.push(number);
        }
    }
    numbers
}

fn infer_storyboard_duration_seconds(shots: &[VideoStoryboardShot]) -> Option<i64> {
    let max_seconds = shots
        .iter()
        .flat_map(|shot| parse_storyboard_time_numbers(&shot.time))
        .filter(|value| value.is_finite() && *value > 0.0)
        .fold(0.0_f64, f64::max);
    if max_seconds > 0.0 {
        Some(max_seconds.ceil() as i64)
    } else {
        None
    }
}

fn storyboard_sound_needs_audio(sound: &str) -> bool {
    let compact = sound.trim().to_ascii_lowercase();
    if compact.is_empty() {
        return false;
    }
    !matches!(
        compact.as_str(),
        "未指定"
            | "无"
            | "无声"
            | "静音"
            | "none"
            | "no audio"
            | "silent"
            | "silence"
            | "mute"
            | "muted"
    )
}

fn storyboard_requests_audio(shots: &[VideoStoryboardShot]) -> bool {
    shots
        .iter()
        .any(|shot| storyboard_sound_needs_audio(&shot.sound))
}

fn apply_video_storyboard_payload_defaults(payload: &mut Value, project_state: Option<&Value>) {
    let storyboard = extract_video_storyboard(payload, project_state);
    if storyboard.is_empty() {
        return;
    }
    let Some(object) = payload.as_object_mut() else {
        return;
    };
    if !object.contains_key("durationSeconds") {
        if let Some(duration_seconds) = infer_storyboard_duration_seconds(&storyboard) {
            object.insert("durationSeconds".to_string(), json!(duration_seconds));
        }
    }
    if !object.contains_key("generateAudio")
        && object
            .get("drivingAudio")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .is_none()
        && storyboard_requests_audio(&storyboard)
    {
        object.insert("generateAudio".to_string(), json!(true));
    }
}

fn default_reference_image_label(generation_mode: &str, index: usize) -> String {
    match generation_mode {
        "first-last-frame" if index == 0 => "first-frame visual reference".to_string(),
        "first-last-frame" if index == 1 => "last-frame visual reference".to_string(),
        "continuation" if index == 0 => "previous clip continuation reference".to_string(),
        _ => "reference-guided visual anchor".to_string(),
    }
}

fn compile_video_generation_prompt(
    payload: &Value,
    project_state: Option<&Value>,
) -> Option<String> {
    let storyboard = extract_video_storyboard(payload, project_state);
    if storyboard.is_empty() {
        return None;
    }

    let base_prompt = payload_string(payload, "prompt")
        .map(|value| value.trim().to_string())
        .unwrap_or_default();
    let generation_mode =
        payload_string(payload, "generationMode").unwrap_or_else(|| "text-to-video".to_string());
    let aspect_ratio = payload_string(payload, "aspectRatio").unwrap_or_else(|| "16:9".to_string());
    let duration_seconds = payload_field(payload, "durationSeconds")
        .and_then(Value::as_i64)
        .unwrap_or(8);
    let reference_images = value_string_list(payload_field(payload, "referenceImages"), 5);
    let reference_image_labels =
        value_string_list(payload_field(payload, "referenceImageLabels"), 5);
    let driving_audio = payload_string(payload, "drivingAudio");
    let generate_audio = payload_bool(payload, &["generateAudio"]).unwrap_or(false);
    let driving_audio_label = payload_string(payload, "drivingAudioLabel").unwrap_or_else(|| {
        "driving audio reference for tone, speaking rhythm, and beat timing".to_string()
    });
    let first_clip = payload_string(payload, "firstClip");

    let mut sections = Vec::<String>::new();

    let mut asset_lines = reference_images
        .iter()
        .enumerate()
        .map(|(index, _)| {
            let label = reference_image_labels
                .get(index)
                .cloned()
                .unwrap_or_else(|| default_reference_image_label(&generation_mode, index));
            format!("Image {}: {}", index + 1, label)
        })
        .collect::<Vec<_>>();
    if let Some(first_clip) = first_clip.filter(|value| !value.trim().is_empty()) {
        let label = payload_string(payload, "firstClipLabel")
            .unwrap_or_else(|| "existing clip reference for motion continuation".to_string());
        if !first_clip.is_empty() {
            asset_lines.push(format!("Clip 1: {label}"));
        }
    }
    if driving_audio.is_some() {
        asset_lines.push(format!("Audio 1: {driving_audio_label}"));
    } else if generate_audio {
        asset_lines.push(
            "Audio generation: create native background music, ambience, or simple sound design from the approved Sound beats.".to_string(),
        );
    }
    if !asset_lines.is_empty() {
        sections.push(asset_lines.join("\n"));
    }

    if !base_prompt.is_empty() && parse_storyboard_markdown(&base_prompt).is_empty() {
        sections.push(format!(
            "Creative brief: {}",
            compact_whitespace(&base_prompt)
        ));
    }

    sections.push(format!(
        "Execution spec: single video, {} seconds, aspect ratio {}, mode {}.",
        duration_seconds, aspect_ratio, generation_mode
    ));

    let storyboard_lines = storyboard
        .iter()
        .enumerate()
        .map(|(index, shot)| {
            format!(
                "Beat {} ({}): Picture: {}; Sound: {}; Shot: {}.",
                index + 1,
                shot.time,
                shot.picture,
                shot.sound,
                shot.shot
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    sections.push(format!("Approved storyboard beats:\n{storyboard_lines}"));

    let mut execution_rules = vec![
        "Follow the beat order exactly; do not collapse the storyboard into one generic summary."
            .to_string(),
        "Preserve the same main character identity, product shape, and prop continuity across all beats."
            .to_string(),
        format!(
            "Keep framing, camera movement, and action progression aligned with the approved {} storyboard.",
            aspect_ratio
        ),
    ];
    if generation_mode == "reference-guided" {
        execution_rules.push(
            "Use the reference images as stable visual anchors for identity, product details, and scene continuity."
                .to_string(),
        );
    }
    if generation_mode == "first-last-frame" {
        execution_rules.push(
            "Respect the first-frame and last-frame references as the fixed endpoints of the motion."
                .to_string(),
        );
    }
    if generation_mode == "continuation" {
        execution_rules.push(
            "Continue naturally from the reference clip instead of resetting the scene or character pose."
                .to_string(),
        );
    }
    if driving_audio.is_some() {
        execution_rules
            .push("Align body rhythm, lip-sync feel, and timing accents with Audio 1.".to_string());
    } else if generate_audio {
        execution_rules.push(
            "Generate native audio that follows the approved Sound column; do not leave the video silent unless the Sound column says silent."
                .to_string(),
        );
    }
    sections.push(format!(
        "Execution requirements:\n- {}",
        execution_rules.join("\n- ")
    ));

    Some(sections.join("\n\n"))
}

fn copy_optional_string(target: &mut Map<String, Value>, key: &str, value: Option<String>) {
    if let Some(value) = value.filter(|item| !item.trim().is_empty()) {
        target.insert(key.to_string(), json!(value));
    }
}

fn split_parent_and_name(path: &str) -> (String, String) {
    match path.rsplit_once('/') {
        Some((parent, name)) => (parent.to_string(), name.to_string()),
        None => (String::new(), path.to_string()),
    }
}

fn payload_bool_value(value: &Value) -> Option<bool> {
    match value {
        Value::Bool(value) => Some(*value),
        Value::Number(value) => Some(value.as_i64().unwrap_or_default() != 0),
        Value::String(text) => match text.trim().to_ascii_lowercase().as_str() {
            "true" | "1" | "yes" | "on" => Some(true),
            "false" | "0" | "no" | "off" => Some(false),
            _ => None,
        },
        _ => None,
    }
}

fn payload_bool(payload: &Value, keys: &[&str]) -> Option<bool> {
    keys.iter()
        .find_map(|key| payload_field(payload, key).and_then(payload_bool_value))
}

fn video_project_create_requested_explicitly(args: &CliArgs, payload: &Value) -> bool {
    args.bool(&[
        "explicit-project-workflow",
        "explicitProjectWorkflow",
        "confirm-project-workflow",
        "confirmProjectWorkflow",
        "allow-project-create",
        "allowProjectCreate",
    ])
    .or_else(|| {
        payload_bool(
            payload,
            &[
                "explicitProjectWorkflow",
                "confirmProjectWorkflow",
                "allowProjectCreate",
            ],
        )
    })
    .unwrap_or(false)
}

fn now_timestamp_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn build_video_project_relative_path(explicit_path: Option<String>) -> String {
    let parent = explicit_path
        .map(|value| normalize_relative_path(&value))
        .map(|normalized| {
            if normalized.rsplit('/').next().unwrap_or("").contains('.') {
                split_parent_and_name(&normalized).0
            } else {
                normalized
            }
        })
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "video".to_string());
    normalize_relative_path(&format!("{parent}/{}", now_timestamp_millis()))
}

fn video_project_stem_from_path(path: &str) -> String {
    let normalized = normalize_relative_path(path);
    normalized
        .rsplit('/')
        .next()
        .unwrap_or(normalized.as_str())
        .trim_end_matches(".md")
        .to_string()
}

fn asset_looks_like_image(asset: &Value) -> bool {
    let mime = asset
        .get("mimeType")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("")
        .to_ascii_lowercase();
    if mime.starts_with("image/") {
        return true;
    }
    [
        "absolutePath",
        "mediaPath",
        "relativePath",
        "src",
        "previewUrl",
    ]
    .into_iter()
    .filter_map(|key| asset.get(key).and_then(Value::as_str))
    .map(str::trim)
    .any(|value| {
        let lower = value.to_ascii_lowercase();
        lower.ends_with(".png")
            || lower.ends_with(".jpg")
            || lower.ends_with(".jpeg")
            || lower.ends_with(".webp")
            || lower.ends_with(".gif")
            || lower.ends_with(".bmp")
            || lower.ends_with(".svg")
    })
}

fn extract_video_project_reference_images(project_state: &Value, limit: usize) -> Vec<String> {
    project_state
        .pointer("/project/assets")
        .or_else(|| project_state.get("assets"))
        .and_then(Value::as_array)
        .map(|assets| {
            assets
                .iter()
                .filter(|asset| asset_looks_like_image(asset))
                .filter_map(|asset| {
                    ["absolutePath", "mediaPath", "relativePath", "src"]
                        .into_iter()
                        .filter_map(|key| asset.get(key).and_then(Value::as_str))
                        .map(str::trim)
                        .find(|value| !value.is_empty())
                        .map(ToString::to_string)
                })
                .take(limit)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

fn merge_video_generation_result(
    mut result: Value,
    video_project_path: Option<String>,
    video_project: Option<Value>,
) -> Value {
    let Some(object) = result.as_object_mut() else {
        return result;
    };
    object.insert("kind".to_string(), json!("generated-videos"));
    if let Some(path) = video_project_path {
        object.insert("videoProjectPath".to_string(), json!(path));
        object.insert(
            "videoProjectId".to_string(),
            json!(video_project_stem_from_path(
                object
                    .get("videoProjectPath")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
            )),
        );
    }
    if let Some(project) = video_project {
        object.insert("videoProject".to_string(), project);
    }
    result
}

fn collect_video_projects(node: &Value, projects: &mut Vec<Value>) {
    let is_directory = node
        .get("isDirectory")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if !is_directory {
        let path = node
            .get("path")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let draft_type = node
            .get("draftType")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        if draft_type == "video" {
            projects.push(json!({
                "path": path,
                "name": node.get("name").cloned().unwrap_or(Value::Null),
                "title": node.get("title").cloned().unwrap_or(Value::Null),
                "updatedAt": node.get("updatedAt").cloned().unwrap_or(Value::Null)
            }));
        }
    }
    if let Some(children) = node.get("children").and_then(Value::as_array) {
        for child in children {
            collect_video_projects(child, projects);
        }
    }
}

fn media_matches_kind(item: &Value, kind: &str) -> bool {
    let mime_type = item
        .get("mimeType")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_ascii_lowercase();
    match kind {
        "image" => mime_type.starts_with("image/"),
        "video" => mime_type.starts_with("video/") || mime_type == "text/markdown",
        _ => false,
    }
}

fn help_response(namespace: Option<&str>) -> Value {
    let namespace = namespace.unwrap_or("root");
    let commands = match namespace {
        "root" => vec![
            "help [namespace]",
            "advisors list|get|list-templates|create|update|delete",
            "chat sessions list|get",
            "spaces list|get|create|rename|delete|switch",
            "assets list|get|search|categories list|create|update|delete",
            "subjects list|get|search|categories list|create|update|delete",
            "manuscripts list|read|write|create|delete|theme apply|preview|create|save|delete|background-upload|previews|layout get|save",
            "media list|get|edit|transcribe|update|bind|delete",
            "voice list|get|clone|bind-asset|speech|delete",
            "image generate|history list|get|providers|models",
            "video generate",
            "knowledge list|search",
            "work list|ready|get|update",
            "memory list|search|recall|add|update|archive|delete|rebuild-index|diagnostics",
            "redclaw runner-status|runner-run-now|runner-start|runner-stop|runner-set-config|task-preview|task-create|task-confirm|task-update|task-cancel|task-list|task-stats|profile-bundle|profile-read|profile-update|profile-onboarding",
            "runtime query|resume|fork-session|get-trace|get-checkpoints|get-tool-results|tasks create|list|get|resume|cancel|background list|get|cancel|team list-sessions|create-session|get-session|add-member|create-task|update-task|request-report|submit-report|mcp-contract|session-enter-diagnostics|session-bridge status|list-sessions|get-session",
            "settings summary|get|set",
            "skills list|invoke|create|save|enable|disable|market-install",
            "mcp list|sessions|oauth-status|save|test|call|list-tools|list-resources|list-resource-templates|disconnect|disconnect-all|discover-local|import-local",
            "ai roles-list|detect-protocol|test-connection",
        ],
        "advisors" => vec![
            "advisors list",
            "advisors get --id <advisorId>",
            "advisors list-templates",
            "advisors create [payload]",
            "advisors update --id <advisorId> [payload]",
            "advisors delete --id <advisorId>",
        ],
        "chat" => vec!["chat sessions list", "chat sessions get --id <sessionId>"],
        "spaces" => vec![
            "spaces list",
            "spaces get --id <spaceId>",
            "spaces rename --id <spaceId> --name <newName>",
            "spaces delete --id <spaceId>",
            "spaces switch --id <spaceId>",
        ],
        "assets" | "subjects" => vec![
            "assets list",
            "assets get --id <assetId>",
            "assets search --query \"keyword\"",
            "assets categories list",
            "assets categories create --name <name>",
            "assets categories update --id <categoryId> --name <name>",
            "assets categories delete --id <categoryId>",
        ],
        "manuscripts" => vec![
            "manuscripts list",
            "manuscripts read --path <relativePath>",
            "manuscripts create-project --title <title> [--kind post|article] [--parent <folder>]",
            "manuscripts write-current [payload.content]",
            "manuscripts write --path <relativePath> [payload.content]",
            "manuscripts create --path <relativePath>",
            "manuscripts delete --path <relativePath>",
            "manuscripts layout get",
            "manuscripts layout save [payload]",
        ],
        "media" => vec![
            "media list",
            "media get --id <assetId>",
            "media edit --source-path <videoPath> [payload.operations]",
            "media transcribe --source-path <videoPath> [--format srt|vtt|text|json]",
            "media update --asset-id <assetId> [--title ...]",
            "media bind --asset-id <assetId> --manuscript-path <path>",
            "media delete --asset-id <assetId>",
        ],
        "voice" => vec![
            "voice list",
            "voice get --voice-id <voiceId>",
            "voice clone --sample-path <audioPath> [--owner-asset-id <assetId>]",
            "voice bind-asset --owner-asset-id <assetId> --voice-id <voiceId>",
            "voice speech --voice-id <voiceId> --input \"text\"",
            "voice delete --voice-id <voiceId>",
        ],
        "image" => vec![
            "image generate --prompt \"...\" [--aspect-ratio 1:1] [--quality high] [--resolution 2K]",
            "image generate --prompt \"...\" [--mode reference-guided] [--reference-images /abs/a.png,/abs/b.png]",
            "image generate --prompt \"...\" [--subject-ids subject_a,subject_b]",
            "image history list",
            "image history get --id <assetId>",
            "image providers",
            "image models",
        ],
        "video" => vec![
            "video analyze --path <workspaceRelativePath> [--mode smart_edit] [payload.instruction]",
            "video generate --prompt \"...\" [--mode text-to-video] [--duration 8] [--resolution 1080p]",
            "video generate --prompt \"...\" --duration 45  # long video: runtime splits into <=15s segments and returns one concatenated video",
            "video generate --prompt \"...\" --mode reference-guided --reference-images /abs/a.png,/abs/b.png",
            "video generate [payload.videoSegments]  # explicit scene segments, each <=15s, concatenated into one final video",
            "video generate --prompt \"...\" --mode first-last-frame --reference-images /abs/first.png,/abs/last.png",
            "video generate --prompt \"...\" --mode continuation --first-clip /abs/clip.mp4",
            "video generate --mode reference-guided --duration 6 --aspect-ratio 9:16  # put approved storyboardMarkdown/storyboardShots in payload so the host can compile the final execution prompt",
        ],
        "knowledge" => vec!["knowledge list", "knowledge search --query \"keyword\""],
        "work" => vec![
            "work list",
            "work ready",
            "work get --id <workId>",
            "work update --id <workId> [--status done]",
        ],
        "memory" => vec![
            "memory list",
            "memory search --query \"keyword\"",
            "memory add [payload.content / payload.tags]",
            "memory delete --id <memoryId>",
        ],
        "redclaw" => vec![
            "redclaw runner-status",
            "redclaw runner-run-now",
            "redclaw runner-start [--interval-minutes 15]",
            "redclaw runner-stop",
            "redclaw runner-set-config [payload]",
            "redclaw task-preview [payload.intent/name/cron/actionType/ownerScope]",
            "redclaw task-create [payload.previewToken + payload.intent]",
            "redclaw task-confirm --draft-id <draftId> [--confirm true]",
            "redclaw task-update --job-definition-id <jobDefinitionId> --reason <reason> [payload.patch]",
            "redclaw task-cancel --job-definition-id <jobDefinitionId> [--reason <reason>]",
            "redclaw task-list [--owner-scope <ownerScope>]",
            "redclaw task-stats",
            "redclaw profile-bundle",
            "redclaw profile-read --doc-type user",
            "redclaw profile-update --doc-type user [payload.markdown]",
            "redclaw profile-complete-style-definition [payload]",
            "redclaw profile-onboarding",
        ],
        "runtime" => vec![
            "runtime query [--session-id <sessionId>] --message \"...\"",
            "runtime resume --session-id <sessionId>",
            "runtime fork-session --session-id <sessionId>",
            "runtime get-trace --session-id <sessionId> [--limit 50]",
            "runtime get-checkpoints --session-id <sessionId> [--limit 50]",
            "runtime get-tool-results --session-id <sessionId> [--limit 50]",
            "runtime tasks create [payload or payload.payload]",
            "runtime tasks list",
            "runtime tasks get --task-id <taskId>",
            "runtime tasks resume --task-id <taskId>",
            "runtime tasks cancel --task-id <taskId>",
            "runtime background list",
            "runtime background get --task-id <taskId>",
            "runtime background cancel --task-id <taskId>",
            "runtime team list-sessions",
            "runtime team create-session [payload.objective/title/runtimeMode]",
            "runtime team get-session --session-id <collabSessionId>",
            "runtime team add-member [payload.sessionId/displayName/roleId/sourceKind]",
            "runtime team create-task [payload.sessionId/title/objective/memberId]",
            "runtime team update-task [payload.taskId/status/memberId]",
            "runtime team send-message [payload.sessionId/toMemberId/body]",
            "runtime team request-report [payload.sessionId/toMemberId/taskId]",
            "runtime team submit-report [payload.sessionId/memberId/taskId/summary/status]",
            "runtime team tick-reports --session-id <collabSessionId>",
            "runtime team list-agent-backends",
            "runtime team mcp-contract",
            "runtime team execute-mcp-tool [payload.toolName/arguments]",
            "runtime session-enter-diagnostics [--title <title>]",
            "runtime session-bridge status",
            "runtime session-bridge list-sessions",
            "runtime session-bridge get-session --session-id <sessionId>",
        ],
        "settings" => vec!["settings summary", "settings get", "settings set [payload]"],
        "skills" => vec![
            "skills list",
            "skills invoke --name <skill>",
            "skills create --name <skill>",
            "skills save --location <path> --content \"...\"",
            "skills enable --name <skill>",
            "skills disable --name <skill>",
            "skills uninstall --name <skill> [--scope user|workspace]",
            "skills install-from-repo --source <github-url-or-owner/repo> [--ref <ref>] [--path <path>] [--scope user|workspace]",
            "skills market-install --slug <slug>  # placeholder registration only; use cli_runtime.* to provision external tools",
        ],
        "mcp" => vec![
            "mcp list",
            "mcp sessions",
            "mcp oauth-status --id <serverId>",
            "mcp save [payload]",
            "mcp test [payload.server]",
            "mcp call --method <method> [payload.server] [payload.params]",
            "mcp list-tools [payload.server]",
            "mcp list-resources [payload.server]",
            "mcp list-resource-templates [payload.server]",
            "mcp disconnect [payload.server]",
            "mcp disconnect-all",
            "mcp discover-local",
            "mcp import-local",
        ],
        "ai" => vec![
            "ai roles-list",
            "ai detect-protocol --base-url <url>",
            "ai test-connection --base-url <url> [--api-key <key>]",
        ],
        _ => vec!["help"],
    };
    json!({
        "success": true,
        "namespace": namespace,
        "commands": commands,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn team_plan_confirmation_accepts_top_level_or_metadata_flag() {
        assert!(require_confirmed_team_plan(
            "team.guide.create",
            &json!({ "userConfirmedTeamPlan": true })
        )
        .is_ok());
        assert!(require_confirmed_team_plan(
            "team.guide.create",
            &json!({ "metadata": { "userConfirmedTeamPlan": true } })
        )
        .is_ok());
    }

    #[test]
    fn team_plan_confirmation_returns_stable_error_code() {
        let error = require_confirmed_team_plan("team.guide.create", &json!({}))
            .expect_err("missing confirmation should fail");

        assert!(error.contains("TEAM_PLAN_CONFIRMATION_REQUIRED"));
        assert!(error.contains("userConfirmedTeamPlan=true"));
    }

    #[test]
    fn generation_agent_auto_execution_requires_explicit_metadata() {
        assert!(generation_agent_auto_execution_metadata(&json!({
            "contextType": "generation-agent",
            "executionMode": "auto",
            "requiresHumanApproval": false
        })));
        assert!(!generation_agent_auto_execution_metadata(&json!({
            "contextType": "generation-agent",
            "executionMode": "auto",
            "requiresHumanApproval": true
        })));
        assert!(!generation_agent_auto_execution_metadata(&json!({
            "contextType": "chat",
            "executionMode": "auto",
            "requiresHumanApproval": false
        })));
    }

    #[test]
    fn build_video_project_relative_path_uses_timestamp_file_name_by_default() {
        let path = build_video_project_relative_path(None);

        assert!(path.starts_with("video/"));
        assert!(path
            .trim_start_matches("video/")
            .chars()
            .all(|ch| ch.is_ascii_digit()));
    }

    #[test]
    fn build_video_project_relative_path_preserves_parent_but_replaces_file_name() {
        let path = build_video_project_relative_path(Some(
            "video/custom/Jamba 戴森V8舞蹈视频".to_string(),
        ));

        assert!(path.starts_with("video/custom/"));
        assert!(path
            .trim_start_matches("video/custom/")
            .chars()
            .all(|ch| ch.is_ascii_digit()));
    }

    #[test]
    fn normalize_authoring_target_subdir_prefixes_wander_folder() {
        assert_eq!(
            normalize_authoring_target_subdir("第一篇稿子", Some("wander")),
            "wander/第一篇稿子"
        );
        assert_eq!(
            normalize_authoring_target_subdir("wander/第一篇稿子", Some("wander")),
            "wander/第一篇稿子"
        );
    }

    #[test]
    fn build_authoring_project_relative_path_uses_folder_name_without_extension() {
        assert_eq!(
            build_authoring_project_relative_path(
                Some("wander"),
                "测试标题-123",
                AuthoringProjectKind::Redpost,
            ),
            "wander/测试标题-123"
        );
        assert_eq!(
            build_authoring_project_relative_path(
                Some("articles"),
                "article-456",
                AuthoringProjectKind::Redarticle,
            ),
            "articles/article-456"
        );
    }

    #[test]
    fn build_authoring_project_id_uses_title_for_post_files() {
        let project_id =
            build_authoring_project_id("测试标题:Redpost", AuthoringProjectKind::Redpost);

        assert!(project_id.starts_with("测试标题-Redpost-"));
        assert!(!project_id.starts_with("post-"));
    }

    #[test]
    fn tokenize_command_keeps_rest_of_unclosed_quoted_prompt() {
        let tokens = tokenize_command(
            "video generate --mode reference-guided --prompt \"Jamba 手持戴森 V8 吸尘器跳舞",
        );

        assert_eq!(tokens[0], "video");
        assert_eq!(tokens[1], "generate");
        assert_eq!(tokens[2], "--mode");
        assert_eq!(tokens[3], "reference-guided");
        assert_eq!(tokens[4], "--prompt");
        assert_eq!(tokens[5], "Jamba 手持戴森 V8 吸尘器跳舞");
    }

    #[test]
    fn video_project_create_requested_explicitly_accepts_cli_and_payload_flags() {
        let cli_args = parse_cli_args(&[
            "--explicit-project-workflow".to_string(),
            "true".to_string(),
        ])
        .expect("cli args should parse");
        assert!(video_project_create_requested_explicitly(
            &cli_args,
            &json!({})
        ));

        assert!(video_project_create_requested_explicitly(
            &CliArgs::default(),
            &json!({ "explicitProjectWorkflow": true })
        ));
        assert!(video_project_create_requested_explicitly(
            &CliArgs::default(),
            &json!({ "confirmProjectWorkflow": "yes" })
        ));
        assert!(!video_project_create_requested_explicitly(
            &CliArgs::default(),
            &json!({})
        ));
    }

    #[test]
    fn extract_video_project_reference_images_reads_project_assets() {
        let refs = extract_video_project_reference_images(
            &json!({
                "project": {
                    "assets": [
                        { "absolutePath": "/tmp/demo.png", "mimeType": "image/png" },
                        { "absolutePath": "/tmp/demo.mp4", "mimeType": "video/mp4" }
                    ]
                }
            }),
            5,
        );

        assert_eq!(refs, vec!["/tmp/demo.png".to_string()]);
    }

    #[test]
    fn parse_storyboard_markdown_reads_standard_table() {
        let shots = parse_storyboard_markdown(
            r#"
视频时长：6 秒

| Time | Picture | Sound | Shot |
| --- | --- | --- | --- |
| 0-2s | Jamba 手持吸尘器左右摇摆 | 轻快节奏配音 | 中景，全身 |
| 2-4s | 一边跳舞一边挥舞吸尘器 | 节奏音乐 + 人声 | 中近景，跟拍 |
"#,
        );

        assert_eq!(shots.len(), 2);
        assert_eq!(shots[0].time, "0-2s");
        assert_eq!(shots[0].picture, "Jamba 手持吸尘器左右摇摆");
        assert_eq!(shots[1].shot, "中近景，跟拍");
    }

    #[test]
    fn compile_video_generation_prompt_includes_storyboard_beats() {
        let prompt = compile_video_generation_prompt(
            &json!({
                "prompt": "Jamba 手持戴森 V8 吸尘器跳舞，整体轻快有趣。",
                "generationMode": "reference-guided",
                "aspectRatio": "9:16",
                "durationSeconds": 6,
                "referenceImages": ["/tmp/jamba.jpg", "/tmp/dyson.jpg"],
                "referenceImageLabels": ["Jamba 人物主体参考", "戴森 V8 产品参考"],
                "drivingAudio": "/tmp/jamba.webm",
                "drivingAudioLabel": "Jamba 声音参考，用于节奏和语气",
                "storyboardShots": [
                    {
                        "time": "0-2s",
                        "picture": "Jamba 手持戴森 V8 吸尘器，身体随节奏左右摇摆。",
                        "sound": "Jamba 声音参考配音，轻快节奏感。",
                        "shot": "中景，人物全身入镜。"
                    },
                    {
                        "time": "2-4s",
                        "picture": "Jamba 一边跳舞一边用吸尘器做挥舞动作。",
                        "sound": "节奏感音乐 + Jamba 声音。",
                        "shot": "中近景，跟随人物移动。"
                    }
                ]
            }),
            None,
        )
        .expect("storyboard prompt should compile");

        assert!(prompt.contains("Image 1: Jamba 人物主体参考"));
        assert!(prompt
            .contains("Beat 1 (0-2s): Picture: Jamba 手持戴森 V8 吸尘器，身体随节奏左右摇摆。"));
        assert!(prompt.contains("Follow the beat order exactly; do not collapse the storyboard into one generic summary."));
        assert!(
            prompt.contains("Align body rhythm, lip-sync feel, and timing accents with Audio 1.")
        );
    }

    #[test]
    fn compile_video_generation_prompt_uses_confirmed_project_script() {
        let prompt = compile_video_generation_prompt(
            &json!({
                "prompt": "生成视频",
                "generationMode": "reference-guided",
                "aspectRatio": "9:16",
                "durationSeconds": 6
            }),
            Some(&json!({
                "project": {
                    "scriptBody": r#"
| 时间 | 画面 | 声音 | 景别 |
| --- | --- | --- | --- |
| 0-2s | Jamba 左右摇摆 | 轻快配音 | 中景 |
"#,
                    "scriptApproval": {
                        "status": "confirmed"
                    }
                }
            })),
        )
        .expect("confirmed project script should compile");

        assert!(
            prompt.contains("Beat 1 (0-2s): Picture: Jamba 左右摇摆; Sound: 轻快配音; Shot: 中景.")
        );
    }

    #[test]
    fn video_storyboard_defaults_infer_duration_and_audio() {
        let mut payload = json!({
            "prompt": "生成视频",
            "generationMode": "reference-guided",
            "storyboardShots": [
                {
                    "time": "0-3s",
                    "picture": "黑色包包旋转展示。",
                    "sound": "低沉节奏背景音乐起。",
                    "shot": "全景"
                },
                {
                    "time": "3-12s",
                    "picture": "镜头推进到五金和皮革细节。",
                    "sound": "音乐渐强。",
                    "shot": "特写"
                }
            ]
        });

        apply_video_storyboard_payload_defaults(&mut payload, None);

        assert_eq!(
            payload_field(&payload, "durationSeconds").and_then(Value::as_i64),
            Some(12)
        );
        assert_eq!(
            payload_field(&payload, "generateAudio").and_then(Value::as_bool),
            Some(true)
        );
    }

    #[test]
    fn video_storyboard_defaults_preserve_explicit_audio_and_duration() {
        let mut payload = json!({
            "prompt": "生成视频",
            "durationSeconds": 6,
            "generateAudio": false,
            "storyboardShots": [
                {
                    "time": "0-12s",
                    "picture": "黑色包包展示。",
                    "sound": "轻节奏背景音乐。",
                    "shot": "全景"
                }
            ]
        });

        apply_video_storyboard_payload_defaults(&mut payload, None);

        assert_eq!(
            payload_field(&payload, "durationSeconds").and_then(Value::as_i64),
            Some(6)
        );
        assert_eq!(
            payload_field(&payload, "generateAudio").and_then(Value::as_bool),
            Some(false)
        );
    }

    #[test]
    fn build_generation_payload_normalizes_video_payload_aliases() {
        let merged = build_generation_payload(
            &CliArgs::default(),
            &json!({
                "prompt": "生成视频",
                "mode": "reference-guided",
                "duration": 6,
                "ratio": "9:16",
                "referenceImages": ["/tmp/jamba.jpg", "/tmp/dyson.jpg"]
            }),
        );

        assert_eq!(
            payload_string(&merged, "generationMode"),
            Some("reference-guided".to_string())
        );
        assert_eq!(
            payload_field(&merged, "durationSeconds").and_then(Value::as_i64),
            Some(6)
        );
        assert_eq!(
            payload_string(&merged, "aspectRatio"),
            Some("9:16".to_string())
        );
    }

    #[test]
    fn build_generation_payload_normalizes_image_ratio_aliases() {
        let merged = build_generation_payload(
            &CliArgs::default(),
            &json!({
                "prompt": "生成小红书竖图封面",
                "aspectRatio": "小红书竖图"
            }),
        );

        assert_eq!(
            payload_string(&merged, "aspectRatio"),
            Some("3:4".to_string())
        );
    }

    #[test]
    fn build_generation_payload_accepts_images_alias_for_image_refs() {
        let merged = build_generation_payload(
            &CliArgs::default(),
            &json!({
                "prompt": "融合参考图风格",
                "images": ["https://example.com/ref-1.png", "https://example.com/ref-2.png"],
                "resolution": "2K"
            }),
        );

        assert_eq!(
            payload_field(&merged, "referenceImages")
                .and_then(Value::as_array)
                .map(Vec::len),
            Some(2)
        );
        assert_eq!(
            payload_string(&merged, "resolution"),
            Some("2K".to_string())
        );
    }

    #[test]
    fn extract_image_plan_items_reads_common_alias_fields() {
        let items = extract_image_plan_items(Some(&json!([
            {
                "name": "封面",
                "visual": "少女在咖啡店窗边看向镜头",
                "caption": "主标题放在左上角"
            },
            {
                "label": "细节页",
                "description": "咖啡杯与桌面甜点特写",
                "overlayText": "副标题强调春日限定"
            }
        ])));

        assert_eq!(items.len(), 2);
        assert_eq!(items[0].title, "封面");
        assert_eq!(items[0].prompt, "少女在咖啡店窗边看向镜头");
        assert_eq!(items[0].copy, "主标题放在左上角");
        assert_eq!(items[1].title, "细节页");
        assert_eq!(items[1].copy, "副标题强调春日限定");
    }

    #[test]
    fn requested_image_generation_count_allows_six_planned_images() {
        assert_eq!(
            requested_image_generation_count(
                &json!({
                    "count": 6
                }),
                6,
            ),
            6
        );
        assert_eq!(
            requested_image_generation_count(
                &json!({
                    "count": 9
                }),
                9,
            ),
            6
        );
    }

    #[test]
    fn image_generation_delivery_mode_defaults_to_inline_wait_for_single_session_image() {
        assert_eq!(
            image_generation_delivery_mode(Some("session-1"), &json!({}), 1),
            ImageGenerationDeliveryMode::InlineWait
        );
        assert_eq!(
            image_generation_delivery_mode(Some("session-1"), &json!({}), 6),
            ImageGenerationDeliveryMode::BackgroundFollowup
        );
        assert_eq!(
            image_generation_delivery_mode(None, &json!({}), 1),
            ImageGenerationDeliveryMode::AsyncSubmit
        );
        assert_eq!(
            image_generation_delivery_mode(None, &json!({ "waitForCompletion": true }), 1),
            ImageGenerationDeliveryMode::InlineWait
        );
    }

    #[test]
    fn agent_image_generation_defaults_to_low_and_1k_when_blank() {
        let mut payload = json!({
            "prompt": "生成故事板",
            "quality": "",
            "resolution": ""
        });

        apply_agent_image_generation_defaults(&mut payload);

        assert_eq!(payload_string(&payload, "quality"), Some("low".to_string()));
        assert_eq!(
            payload_string(&payload, "resolution"),
            Some("1K".to_string())
        );
    }

    #[test]
    fn agent_image_generation_defaults_do_not_override_explicit_values() {
        let mut payload = json!({
            "prompt": "生成主视觉",
            "quality": "high",
            "resolution": "2K"
        });

        apply_agent_image_generation_defaults(&mut payload);

        assert_eq!(
            payload_string(&payload, "quality"),
            Some("high".to_string())
        );
        assert_eq!(
            payload_string(&payload, "resolution"),
            Some("2K".to_string())
        );
    }

    #[test]
    fn video_generation_waits_by_default_inside_session() {
        assert!(video_generation_should_wait(Some("session-1"), &json!({})));
        assert!(!video_generation_should_wait(None, &json!({})));
        assert!(!video_generation_should_wait(
            Some("session-1"),
            &json!({ "waitForCompletion": false })
        ));
        assert!(!video_generation_should_wait(
            Some("session-1"),
            &json!({ "backgroundFollowup": true })
        ));
        assert!(video_generation_should_wait(
            None,
            &json!({ "waitForCompletion": true })
        ));
    }

    #[test]
    fn compile_image_batch_prompt_includes_order_and_shared_style() {
        let prompt = compile_image_batch_prompt(
            "为春季咖啡品牌做一组 3 张小红书配图",
            Some("胶片感、奶油白主色、逆光边缘、统一浅景深"),
            &ImageGenerationPlanItem {
                title: "第 2 张 产品特写".to_string(),
                prompt: "桌面咖啡杯、甜点与花瓣的近景构图".to_string(),
                copy: "杯套上留出品牌标题区域".to_string(),
            },
            1,
            3,
        );

        assert!(prompt.contains("整组创意任务：为春季咖啡品牌做一组 3 张小红书配图"));
        assert!(prompt.contains("这是同一组连续视觉中的第 2/3 张图片。"));
        assert!(prompt.contains("全组统一风格锚点：胶片感、奶油白主色、逆光边缘、统一浅景深"));
        assert!(prompt.contains("跨图一致性要求：保持同一主体身份"));
    }

    #[test]
    fn skill_name_from_args_or_payload_accepts_structured_payload_name() {
        assert_eq!(
            skill_name_from_args_or_payload(
                &CliArgs::default(),
                &json!({ "name": "image-director" })
            ),
            Some("image-director".to_string())
        );
        assert_eq!(
            skill_name_from_args_or_payload(
                &CliArgs::default(),
                &json!({ "skillName": "image-director" })
            ),
            Some("image-director".to_string())
        );
    }

    #[test]
    fn evaluate_skill_host_save_rule_matches_isolated_separator_only() {
        let rule = SkillHostSaveRule {
            rule_type: "line_equals_any".to_string(),
            message: "正文包含孤立分隔线".to_string(),
            values: vec!["---".to_string(), "***".to_string()],
            count: None,
            case_insensitive: false,
        };

        assert!(evaluate_skill_host_save_rule(&rule, "标题\n---\n正文"));
        assert!(!evaluate_skill_host_save_rule(&rule, "标题 --- 正文"));
        assert!(!evaluate_skill_host_save_rule(&rule, "| --- | --- |"));
    }

    #[test]
    fn evaluate_skill_host_save_rule_detects_blank_line_run() {
        let rule = SkillHostSaveRule {
            rule_type: "blank_line_run_at_least".to_string(),
            message: "正文包含连续三个空行".to_string(),
            values: Vec::new(),
            count: Some(3),
            case_insensitive: false,
        };

        assert!(evaluate_skill_host_save_rule(&rule, "第一段\n\n\n第二段"));
        assert!(!evaluate_skill_host_save_rule(&rule, "第一段\n\n第二段"));
    }

    #[test]
    fn writing_style_host_save_validators_are_machine_readable() {
        let workspace = crate::redbox_project_root();
        let bundle =
            load_skill_bundle_sections_from_sources("writing-style", Some(workspace.as_path()));
        let raw = bundle
            .rules
            .get("host-save-validators.json")
            .expect("writing-style should define host save validators");
        let parsed: SkillHostSaveValidatorSet =
            serde_json::from_str(raw).expect("validator json should parse");

        assert_eq!(parsed.applies_to, vec!["article"]);
        assert_eq!(parsed.rules.len(), 3);
        assert!(parsed
            .rules
            .iter()
            .any(|rule| rule.rule_type == "line_equals_any"));
    }

    #[test]
    fn normalized_app_cli_action_key_accepts_common_variants() {
        assert_eq!(
            normalized_app_cli_action_key("manuscripts.writeCurrent"),
            "manuscriptswritecurrent"
        );
        assert_eq!(
            normalized_app_cli_action_key("manuscripts.write-current"),
            "manuscriptswritecurrent"
        );
        assert_eq!(
            normalized_app_cli_action_key("manuscripts/write_current"),
            "manuscriptswritecurrent"
        );
        assert_eq!(
            normalized_app_cli_action_key("redclaw.task.preview"),
            "redclawtaskpreview"
        );
        assert_eq!(
            normalized_app_cli_action_key("redclaw/task-list"),
            "redclawtasklist"
        );
        assert_eq!(
            normalized_app_cli_action_key("team.session.create"),
            "teamsessioncreate"
        );
        assert_eq!(
            normalized_app_cli_action_key("team.member.spawn"),
            "teammemberspawn"
        );
    }

    #[test]
    fn bound_manuscript_write_call_requires_universal_write_compat() {
        assert!(is_bound_manuscript_write_call(&json!({
            "action": "manuscripts.writeCurrent",
            "payload": { "content": "body" },
            "__compat": {
                "legacyToolName": "Write",
                "legacyCommand": "manuscripts://current"
            }
        })));

        assert!(!is_bound_manuscript_write_call(&json!({
            "action": "manuscripts.writeCurrent",
            "payload": { "content": "body" },
            "__compat": {
                "legacyToolName": "Operate",
                "legacyCommand": "manuscripts.writeCurrent"
            }
        })));

        assert!(!is_bound_manuscript_write_call(&json!({
            "action": "manuscripts.writeCurrent",
            "payload": { "content": "body" }
        })));
    }

    #[test]
    fn normalized_structured_arguments_preserves_redclaw_task_cancel_draft_id() {
        let normalized = normalized_structured_arguments(&json!({
            "action": "redclaw.task.cancel",
            "draftId": "taskdraft-123",
            "reason": "重新创建任务"
        }));
        assert_eq!(
            normalized.pointer("/payload/draftId"),
            Some(&json!("taskdraft-123"))
        );
        assert_eq!(
            normalized.pointer("/payload/reason"),
            Some(&json!("重新创建任务"))
        );
    }

    #[test]
    fn app_cli_error_json_is_structured() {
        let payload = app_cli_error_json(
            Some("memory.search"),
            "ACTION_FAILED",
            "memory backend unavailable",
            true,
            Some(json!({ "query": "creator" })),
        );
        let parsed: Value = serde_json::from_str(&payload).expect("structured JSON");
        assert_eq!(parsed.get("ok"), Some(&json!(false)));
        assert_eq!(parsed.get("action"), Some(&json!("memory.search")));
        assert_eq!(parsed.pointer("/error/code"), Some(&json!("ACTION_FAILED")));
        assert_eq!(parsed.pointer("/error/retryable"), Some(&json!(true)));
    }

    #[test]
    fn app_cli_action_error_preserves_structured_tool_errors() {
        let nested = app_cli_error_json(
            Some("video.analyze"),
            "PROVIDER_ERROR",
            "provider rejected video input",
            true,
            Some(json!({ "protocol": "openai" })),
        );
        let preserved = app_cli_action_error("video.analyze", &nested);
        let parsed: Value = serde_json::from_str(&preserved).expect("structured JSON");

        assert_eq!(
            parsed.pointer("/error/code"),
            Some(&json!("PROVIDER_ERROR"))
        );
        assert_eq!(parsed.pointer("/error/retryable"), Some(&json!(true)));
        assert_eq!(
            parsed.pointer("/error/details/protocol"),
            Some(&json!("openai"))
        );
    }

    #[test]
    fn normalized_structured_arguments_lifts_flat_fields_into_payload() {
        let normalized = normalized_structured_arguments(&json!({
            "action": "manuscripts.createProject",
            "kind": "post",
            "parent": "wander",
            "title": "测试标题"
        }));
        assert_eq!(normalized.pointer("/payload/kind"), Some(&json!("post")));
        assert_eq!(
            normalized.pointer("/payload/parent"),
            Some(&json!("wander"))
        );
        assert_eq!(
            normalized.pointer("/payload/title"),
            Some(&json!("测试标题"))
        );
    }

    #[test]
    fn normalized_structured_arguments_parses_stringified_payload() {
        let normalized = normalized_structured_arguments(&json!({
            "action": "manuscripts.createProject",
            "payload": "{\"kind\":\"post\",\"parent\":\"wander\",\"title\":\"测试标题\"}"
        }));
        assert_eq!(normalized.pointer("/payload/kind"), Some(&json!("post")));
        assert_eq!(
            normalized.pointer("/payload/parent"),
            Some(&json!("wander"))
        );
        assert_eq!(
            normalized.pointer("/payload/title"),
            Some(&json!("测试标题"))
        );
    }

    #[test]
    fn subject_helpers_accept_payload_id_and_query() {
        let args = CliArgs::default();
        assert_eq!(
            subject_id_from_args_or_payload(
                &args,
                &json!({ "assetId": "subject_1774704234274_53536cc0" })
            ),
            Some("subject_1774704234274_53536cc0".to_string())
        );
        assert_eq!(
            subject_query_from_args_or_payload(&args, &json!({ "name": "Jamba" })),
            Some("Jamba".to_string())
        );
        assert_eq!(
            subject_category_from_args_or_payload(
                &args,
                &json!({ "categoryId": "subject_cat_person" })
            ),
            Some("subject_cat_person".to_string())
        );
    }

    #[test]
    fn memory_action_request_routes_list_to_memory_list_channel() {
        let (channel, payload) =
            memory_action_request("list", &CliArgs::default(), &json!({})).expect("list request");
        assert_eq!(channel, "memory:list");
        assert_eq!(payload, json!({}));
    }

    #[test]
    fn memory_action_request_prefers_flag_query_then_payload_then_positionals() {
        let flag_args = parse_cli_args(&["--query".to_string(), "flag query".to_string()])
            .expect("cli args should parse");
        let (_, flag_payload) =
            memory_action_request("search", &flag_args, &json!({ "query": "payload query" }))
                .expect("search request");
        assert_eq!(flag_payload.get("query"), Some(&json!("flag query")));

        let payload_args = CliArgs::default();
        let (_, payload_only) = memory_action_request(
            "search",
            &payload_args,
            &json!({ "query": "payload query" }),
        )
        .expect("search request");
        assert_eq!(payload_only.get("query"), Some(&json!("payload query")));

        let positional_args = parse_cli_args(&["复盘".to_string(), "偏好".to_string()])
            .expect("cli args should parse");
        let (_, positional_payload) =
            memory_action_request("search", &positional_args, &json!({})).expect("search request");
        assert_eq!(positional_payload.get("query"), Some(&json!("复盘 偏好")));
    }

    #[test]
    fn memory_action_request_merges_add_payload_with_cli_options() {
        let args = parse_cli_args(&[
            "--content".to_string(),
            "用户偏好简洁方案".to_string(),
            "--type".to_string(),
            "preference".to_string(),
        ])
        .expect("cli args should parse");
        let (_, payload) =
            memory_action_request("add", &args, &json!({ "tags": ["style", "execution"] }))
                .expect("add request");

        assert_eq!(payload.get("content"), Some(&json!("用户偏好简洁方案")));
        assert_eq!(payload.get("type"), Some(&json!("preference")));
        assert_eq!(payload.get("tags"), Some(&json!(["style", "execution"])));
    }

    #[test]
    fn memory_action_request_builds_delete_payload_and_requires_id() {
        let args = parse_cli_args(&["memory-1".to_string()]).expect("cli args should parse");
        let (channel, payload) =
            memory_action_request("delete", &args, &json!({})).expect("delete request");
        assert_eq!(channel, "memory:delete");
        assert_eq!(payload, json!("memory-1"));

        let err = memory_action_request("delete", &CliArgs::default(), &json!({}))
            .expect_err("delete without id should fail");
        assert!(err.contains("memory delete requires --id"));
    }

    #[test]
    fn memory_action_request_routes_extended_actions() {
        let args = parse_cli_args(&[
            "--query".to_string(),
            "verification".to_string(),
            "--scope".to_string(),
            "project".to_string(),
        ])
        .expect("cli args should parse");
        let (recall_channel, recall_payload) =
            memory_action_request("recall", &args, &json!({})).expect("recall request");
        assert_eq!(recall_channel, "memory:recall");
        assert_eq!(recall_payload.get("query"), Some(&json!("verification")));
        assert_eq!(recall_payload.get("scope"), Some(&json!("project")));

        let (update_channel, update_payload) = memory_action_request(
            "update",
            &CliArgs::default(),
            &json!({ "id": "memory-1", "content": "Updated" }),
        )
        .expect("update request");
        assert_eq!(update_channel, "memory:update");
        assert_eq!(update_payload.get("id"), Some(&json!("memory-1")));

        let (archive_channel, _) =
            memory_action_request("archive", &CliArgs::default(), &json!({ "id": "memory-1" }))
                .expect("archive request");
        assert_eq!(archive_channel, "memory:archive");

        let (rebuild_channel, rebuild_payload) =
            memory_action_request("rebuild-index", &CliArgs::default(), &json!({}))
                .expect("rebuild request");
        assert_eq!(rebuild_channel, "memory:rebuild-index");
        assert_eq!(rebuild_payload, json!({}));

        let (diagnostics_channel, diagnostics_payload) =
            memory_action_request("diagnostics", &CliArgs::default(), &json!({}))
                .expect("diagnostics request");
        assert_eq!(diagnostics_channel, "memory:diagnostics");
        assert_eq!(diagnostics_payload, json!({}));
    }
}
