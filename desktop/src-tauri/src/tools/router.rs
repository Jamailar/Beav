use crate::mcp::McpToolInfo;
use serde_json::{json, Value};

use crate::tools::action_aliases::canonicalize_app_cli_arguments;
use crate::tools::catalog::descriptor_by_name;
use crate::tools::compat::{canonical_tool_name, is_legacy_tool_alias, normalize_tool_call};
use crate::tools::plan::ToolRegistryPlan;
use crate::{payload_string, storage_safe_file_stem};

#[derive(Debug, Clone)]
pub struct PreparedToolCall {
    pub name: String,
    pub arguments: Value,
    pub plan_fingerprint: String,
    pub mcp_tool: Option<McpToolInfo>,
    pub mcp_resource: Option<McpResourcePreparedCall>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum McpResourcePreparedCall {
    ListResources,
    ListResourceTemplates,
    ReadResource,
}

#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct ToolResultEnvelope {
    pub tool_name: String,
    pub action: Option<String>,
    pub ok: bool,
    pub data: Option<Value>,
    pub error: Option<ToolRouteError>,
    pub plan_fingerprint: String,
}

#[derive(Debug, Clone)]
pub struct ToolRouteError {
    pub code: &'static str,
    pub message: String,
    pub retryable: bool,
    pub details: Option<Value>,
}

impl ToolRouteError {
    pub fn to_json_string(&self, tool_name: Option<&str>, action: Option<&str>) -> String {
        let mut object = serde_json::Map::new();
        object.insert("ok".to_string(), json!(false));
        if let Some(tool_name) = tool_name {
            object.insert("tool".to_string(), json!(tool_name));
        }
        if let Some(action) = action {
            object.insert("action".to_string(), json!(action));
        }
        let mut error = serde_json::Map::new();
        error.insert("code".to_string(), json!(self.code));
        error.insert("message".to_string(), json!(self.message));
        error.insert("retryable".to_string(), json!(self.retryable));
        if let Some(details) = &self.details {
            error.insert("details".to_string(), details.clone());
        }
        object.insert("error".to_string(), Value::Object(error));
        serde_json::to_string_pretty(&Value::Object(object)).unwrap_or_else(|_| {
            format!(
                r#"{{"ok":false,"error":{{"code":"{}","message":"{}","retryable":{}}}}}"#,
                self.code, self.message, self.retryable
            )
        })
    }
}

#[derive(Debug, Clone)]
pub struct ToolRouter {
    plan: ToolRegistryPlan,
}

#[allow(dead_code)]
impl ToolRouter {
    pub fn new(plan: ToolRegistryPlan) -> Self {
        Self { plan }
    }

    pub fn plan(&self) -> &ToolRegistryPlan {
        &self.plan
    }

    pub fn prepare(&self, name: &str, arguments: &Value) -> Result<PreparedToolCall, String> {
        if is_legacy_tool_alias(name) {
            return Err(self
                .error(
                    "LEGACY_TOOL_ALIAS_DISABLED",
                    format!(
                        "legacy tool alias `{name}` is disabled for this session; use the canonical tools shown in visibleTools"
                    ),
                    false,
                    Some(json!({
                        "visibleTools": self.visible_tool_names(),
                    })),
                )
                .to_json_string(Some(name), None));
        }
        if name.trim() == "Operate" {
            self.validate_operate_call(arguments)?;
        }
        if name.trim() == "Write" {
            if let Some(prepared) = self.prepare_unbound_artifact_write(arguments) {
                return Ok(prepared);
            }
            self.validate_write_call(arguments)?;
        }
        let raw_allowed = self.is_allowed_tool_name(name);
        if let Some(tool) = self.plan.direct_mcp_tool(name).cloned() {
            return Ok(PreparedToolCall {
                name: name.to_string(),
                arguments: if arguments.is_object() {
                    arguments.clone()
                } else {
                    json!({})
                },
                plan_fingerprint: self.plan.fingerprint.clone(),
                mcp_tool: Some(tool),
                mcp_resource: None,
            });
        }
        if let Some(resource_call) = self.prepare_mcp_resource_tool(name) {
            return Ok(PreparedToolCall {
                name: name.to_string(),
                arguments: if arguments.is_object() {
                    arguments.clone()
                } else {
                    json!({})
                },
                plan_fingerprint: self.plan.fingerprint.clone(),
                mcp_tool: None,
                mcp_resource: Some(resource_call),
            });
        }
        if let Some(tool) = self.plan.deferred_mcp_tool(name) {
            return Err(self
                .error(
                    "TOOL_DEFERRED",
                    format!("MCP tool `{name}` is available but not directly exposed in this turn"),
                    true,
                    Some(json!({
                        "suggestedAction": "tool_search",
                        "queryHint": format!("{} {}", tool.server_name, tool.description.clone().unwrap_or_default()),
                        "deferredMcpNamespaces": self.plan.mcp_tool_namespaces,
                    })),
                )
                .to_json_string(Some(name), None));
        }
        if self.is_legacy_workflow_command(name, arguments) {
            return Err(self
                .error(
                    "LEGACY_COMMAND_DISABLED",
                    "legacy workflow command strings are disabled for this session; use Operate with a structured resource and operation".to_string(),
                    false,
                    Some(json!({
                        "visibleTools": self.visible_tool_names(),
                    })),
                )
                .to_json_string(Some(name), None));
        }
        let normalized_call = normalize_tool_call(name, arguments);
        let normalized_name = normalized_call.name;
        if normalized_name.is_empty() {
            return Err(self
                .error(
                    "TOOL_NOT_AVAILABLE",
                    format!("tool `{name}` is not available in this turn"),
                    false,
                    Some(json!({
                        "visibleTools": self.visible_tool_names(),
                    })),
                )
                .to_json_string(Some(name), None));
        }
        if !raw_allowed && !self.is_allowed_tool_name(normalized_name) {
            return Err(self
                .error(
                    "TOOL_NOT_AVAILABLE",
                    format!("tool `{name}` is not available in this turn"),
                    false,
                    Some(json!({
                        "normalizedToolName": normalized_name,
                        "visibleTools": self.visible_tool_names(),
                    })),
                )
                .to_json_string(Some(normalized_name), None));
        }
        if let Some(tool) = self.plan.direct_mcp_tool(normalized_name).cloned() {
            return Ok(PreparedToolCall {
                name: normalized_name.to_string(),
                arguments: normalized_call.arguments,
                plan_fingerprint: self.plan.fingerprint.clone(),
                mcp_tool: Some(tool),
                mcp_resource: None,
            });
        }
        if let Some(resource_call) = self.prepare_mcp_resource_tool(normalized_name) {
            return Ok(PreparedToolCall {
                name: normalized_name.to_string(),
                arguments: normalized_call.arguments,
                plan_fingerprint: self.plan.fingerprint.clone(),
                mcp_tool: None,
                mcp_resource: Some(resource_call),
            });
        }
        if let Some(tool) = self.plan.deferred_mcp_tool(normalized_name) {
            return Err(self
                .error(
                    "TOOL_DEFERRED",
                    format!(
                        "MCP tool `{normalized_name}` is available but not directly exposed in this turn"
                    ),
                    true,
                    Some(json!({
                        "suggestedAction": "tool_search",
                        "queryHint": format!("{} {}", tool.server_name, tool.description.clone().unwrap_or_default()),
                        "deferredMcpNamespaces": self.plan.mcp_tool_namespaces,
                    })),
                )
                .to_json_string(Some(normalized_name), None));
        }
        let normalized_arguments = if normalized_name == "workflow" {
            canonicalize_app_cli_arguments(&normalized_call.arguments)
        } else {
            normalized_call.arguments
        };
        if normalized_name == "workflow" {
            self.ensure_app_cli_action_allowed(&normalized_arguments)?;
        }
        Ok(PreparedToolCall {
            name: normalized_name.to_string(),
            arguments: normalized_arguments,
            plan_fingerprint: self.plan.fingerprint.clone(),
            mcp_tool: None,
            mcp_resource: None,
        })
    }

    pub fn supports_parallel(&self, prepared: &PreparedToolCall) -> bool {
        if let Some(tool) = &prepared.mcp_tool {
            return tool.supports_parallel_tool_calls && !tool.destructive;
        }
        if prepared.mcp_resource.is_some() {
            return true;
        }
        let descriptor_allows = descriptor_by_name(&prepared.name)
            .map(|descriptor| descriptor.concurrency_safe)
            .unwrap_or(false);
        if !descriptor_allows {
            return false;
        }
        if prepared.name != "workflow" {
            return descriptor_allows;
        }
        let Some(action) = payload_string(&prepared.arguments, "action") else {
            return false;
        };
        self.plan
            .direct_app_cli_actions
            .iter()
            .find(|descriptor| descriptor.action == action)
            .map(|descriptor| descriptor.concurrency_safe)
            .unwrap_or(false)
    }

    pub fn success_envelope(&self, prepared: &PreparedToolCall, data: Value) -> ToolResultEnvelope {
        ToolResultEnvelope {
            tool_name: prepared.name.to_string(),
            action: payload_string(&prepared.arguments, "action"),
            ok: true,
            data: Some(data),
            error: None,
            plan_fingerprint: self.plan.fingerprint.clone(),
        }
    }

    pub fn failure_envelope(
        &self,
        prepared: Option<&PreparedToolCall>,
        error: ToolRouteError,
    ) -> ToolResultEnvelope {
        ToolResultEnvelope {
            tool_name: prepared
                .map(|item| item.name.to_string())
                .unwrap_or_else(|| "unknown".to_string()),
            action: prepared.and_then(|item| payload_string(&item.arguments, "action")),
            ok: false,
            data: None,
            error: Some(error),
            plan_fingerprint: self.plan.fingerprint.clone(),
        }
    }

    fn ensure_app_cli_action_allowed(&self, arguments: &Value) -> Result<(), String> {
        let Some(action) = payload_string(arguments, "action") else {
            return Ok(());
        };
        if action == "manuscripts.writeCurrent" && self.is_bound_manuscript_write(arguments) {
            return Ok(());
        }
        if action == "manuscripts.createProject"
            && self.is_standalone_artifact_manuscript_create(arguments)
        {
            return Err(self
                .error(
                    "MANUSCRIPT_PROJECT_NOT_NEEDED_FOR_STANDALONE_ARTIFACT",
                    "Do not create a manuscript project for a standalone script package; save the generated HTML or Markdown artifact under manuscripts/ with workspace.write".to_string(),
                    true,
                    Some(json!({
                        "suggestedAction": "workspace.write",
                        "suggestedPayload": {
                            "resource": "workspace",
                            "operation": "write",
                            "input": {
                                "path": "manuscripts/<short-kebab-title>.html",
                                "content": "<complete self-contained HTML script package>"
                            }
                        },
                        "doNotUse": [
                            "tool_search manuscript create",
                            "manuscripts.createProject",
                            "Write manuscripts://current"
                        ],
                        "reason": "standalone script packages do not require a bound manuscript project"
                    })),
                )
                .to_json_string(Some("workflow"), Some(&action)));
        }
        if self.plan.has_direct_app_cli_action(&action) {
            return Ok(());
        }
        if let Some(deferred) = self
            .plan
            .deferred_app_cli_actions
            .iter()
            .find(|entry| entry.action == action)
        {
            return Err(self
                .error(
                    "ACTION_DEFERRED",
                    format!("action `{action}` is available but not directly exposed in this turn"),
                    true,
                    Some(json!({
                        "suggestedAction": "tool_search",
                        "queryHint": format!("{} {}", deferred.namespace, deferred.description),
                        "deferredNamespaces": self.plan.deferred_action_namespaces,
                    })),
                )
                .to_json_string(Some("workflow"), Some(&action)));
        }
        Err(self
            .error(
                "ACTION_NOT_AVAILABLE",
                format!("action `{action}` is not available in this runtime"),
                false,
                Some(json!({
                    "runtimeMode": self.plan.runtime_mode,
                    "directActions": self
                        .plan
                        .direct_app_cli_actions
                        .iter()
                        .map(|descriptor| descriptor.action)
                        .collect::<Vec<_>>(),
                })),
            )
            .to_json_string(Some("workflow"), Some(&action)))
    }

    fn is_allowed_tool_name(&self, name: &str) -> bool {
        let canonical = canonical_tool_name(name);
        self.plan.visible_tools.iter().any(|tool| tool.name == name)
            || self
                .plan
                .internal_tool_names
                .iter()
                .any(|item| item == canonical || item == name)
            || self.plan.direct_mcp_tool(name).is_some()
            || self.plan.deferred_mcp_tool(name).is_some()
            || self.prepare_mcp_resource_tool(name).is_some()
    }

    fn is_legacy_workflow_command(&self, name: &str, arguments: &Value) -> bool {
        matches!(name.trim(), "workflow")
            && arguments.get("action").and_then(Value::as_str).is_none()
            && arguments.get("command").and_then(Value::as_str).is_some()
            && !self.has_structured_operate_payload(arguments)
    }

    fn has_structured_operate_payload(&self, arguments: &Value) -> bool {
        arguments
            .get("payload")
            .and_then(Value::as_object)
            .is_some_and(|payload| {
                payload
                    .get("resource")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .is_some_and(|value| !value.is_empty())
                    && payload
                        .get("operation")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .is_some_and(|value| !value.is_empty())
            })
    }

    fn validate_operate_call(&self, arguments: &Value) -> Result<(), String> {
        let Some(object) = arguments.as_object() else {
            return Err(self
                .error(
                    "MISSING_OPERATE_FIELDS",
                    "Operate requires structured resource and operation fields".to_string(),
                    false,
                    Some(json!({
                        "requiredFields": ["resource", "operation"],
                        "visibleTools": self.visible_tool_names(),
                    })),
                )
                .to_json_string(Some("Operate"), None));
        };
        let operate_object = if object.get("resource").and_then(Value::as_str).is_some()
            || object.get("operation").and_then(Value::as_str).is_some()
        {
            object
        } else {
            object
                .get("input")
                .and_then(Value::as_object)
                .unwrap_or(object)
        };
        let resource = operate_object
            .get("resource")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or_default();
        let operation = operate_object
            .get("operation")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or_default();
        if resource.is_empty() || operation.is_empty() {
            return Err(self
                .error(
                    if operate_object.is_empty() {
                        "EMPTY_OPERATE_CALL"
                    } else {
                        "MISSING_OPERATE_FIELDS"
                    },
                    "Operate requires non-empty resource and operation fields; do not call Operate as a help or planning probe".to_string(),
                    false,
                    Some(json!({
                        "requiredFields": ["resource", "operation"],
                        "receivedFields": operate_object.keys().collect::<Vec<_>>(),
                        "visibleTools": self.visible_tool_names(),
                    })),
                )
                .to_json_string(Some("Operate"), None));
        }
        let resource_key = resource.trim().to_ascii_lowercase();
        let operation_key = operation
            .trim()
            .chars()
            .filter(|ch| ch.is_ascii_alphanumeric())
            .flat_map(|ch| ch.to_lowercase())
            .collect::<String>();
        if matches!(resource_key.as_str(), "manuscript" | "manuscripts")
            && matches!(
                operation_key.as_str(),
                "write" | "writecurrent" | "update" | "run"
            )
        {
            return Err(self
                .error(
                    "MANUSCRIPT_WRITE_REQUIRES_WRITE",
                    "Use Write(path=\"manuscripts://current\", content=\"完整正文\") instead of Operate for manuscript body saves".to_string(),
                    false,
                    Some(json!({
                        "suggestedTool": "Write",
                        "suggestedArguments": {
                            "path": "manuscripts://current",
                            "content": "完整正文"
                        },
                    })),
                )
                .to_json_string(Some("Operate"), Some("manuscripts.writeCurrent")));
        }
        Ok(())
    }

    fn prepare_unbound_artifact_write(&self, arguments: &Value) -> Option<PreparedToolCall> {
        if !self.plan.allowed_write_targets.is_empty() {
            return None;
        }
        let path = arguments
            .get("path")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or_default();
        let is_unbound_target =
            path.is_empty() || path.eq_ignore_ascii_case("manuscripts://current");
        if !is_unbound_target {
            return None;
        }
        let content = arguments.get("content").and_then(Value::as_str)?;
        if !looks_like_complete_html_artifact(content) {
            return None;
        }
        let filename = html_artifact_filename(content);
        let target_path = format!("manuscripts/{filename}");
        let legacy_command = if path.is_empty() {
            "standalone-artifact"
        } else {
            path
        };
        Some(PreparedToolCall {
            name: "resource".to_string(),
            arguments: json!({
                "action": "workspace.write",
                "path": target_path.clone(),
                "content": content,
                "__compat": {
                    "legacyToolName": "Write",
                    "legacyCommand": legacy_command,
                    "translatedAction": "workspace.write"
                },
                "writeRecoveryDecision": {
                    "reason": "unbound_write_complete_html_artifact",
                    "originalTool": "Write",
                    "targetPath": target_path,
                    "contentChars": content.chars().count()
                }
            }),
            plan_fingerprint: self.plan.fingerprint.clone(),
            mcp_tool: None,
            mcp_resource: None,
        })
    }

    fn validate_write_call(&self, arguments: &Value) -> Result<(), String> {
        let path = arguments
            .get("path")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or_default();
        if !path.starts_with("workspace://") && self.plan.allowed_write_targets.is_empty() {
            return Ok(());
        }
        if !path.starts_with("workspace://")
            && self
                .plan
                .allowed_write_targets
                .iter()
                .any(|target| target == path)
        {
            return Ok(());
        }
        let details = if let Some(workspace_path) = path.strip_prefix("workspace://") {
            let workspace_path = workspace_path.trim_start_matches('/');
            json!({
                "allowedWriteTargets": self.plan.allowed_write_targets.clone(),
                "visibleTools": self.visible_tool_names(),
                "unsupportedScheme": "workspace",
                "reason": "Write only saves currently bound manuscript/editor resources in this turn",
                "suggestedAction": "workspace.write",
                "suggestedArguments": {
                    "action": "workspace.write",
                    "path": if workspace_path.is_empty() { "<workspace-relative-file>" } else { workspace_path },
                    "content": "<complete UTF-8 content>"
                },
                "suggestionAvailability": "Use the structured workspace.write file action when it is exposed by the current runtime"
            })
        } else {
            json!({
                "allowedWriteTargets": self.plan.allowed_write_targets.clone(),
                "visibleTools": self.visible_tool_names(),
            })
        };
        Err(self
            .error(
                "WRITE_TARGET_NOT_ALLOWED",
                format!("Write target `{path}` is not available in this turn"),
                false,
                Some(details),
            )
            .to_json_string(Some("Write"), None))
    }

    fn is_bound_manuscript_write(&self, arguments: &Value) -> bool {
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

    fn is_standalone_artifact_manuscript_create(&self, arguments: &Value) -> bool {
        let compat = arguments.get("__compat").and_then(Value::as_object);
        let legacy_tool = compat
            .and_then(|object| object.get("legacyToolName"))
            .and_then(Value::as_str)
            .unwrap_or_default();
        let legacy_command = compat
            .and_then(|object| object.get("legacyCommand"))
            .and_then(Value::as_str)
            .unwrap_or_default();
        let payload_path = arguments
            .get("payload")
            .and_then(Value::as_object)
            .and_then(|payload| payload.get("path"))
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or_default();
        legacy_tool == "Operate"
            && legacy_command.eq_ignore_ascii_case("manuscript.create")
            && (payload_path.is_empty()
                || payload_path.eq_ignore_ascii_case("manuscripts://current"))
    }

    fn prepare_mcp_resource_tool(&self, name: &str) -> Option<McpResourcePreparedCall> {
        if self.plan.mcp_tool_namespaces.is_empty() {
            return None;
        }
        match name {
            "list_mcp_resources" => Some(McpResourcePreparedCall::ListResources),
            "list_mcp_resource_templates" => Some(McpResourcePreparedCall::ListResourceTemplates),
            "read_mcp_resource" => Some(McpResourcePreparedCall::ReadResource),
            _ => None,
        }
    }

    fn visible_tool_names(&self) -> Vec<&'static str> {
        self.plan
            .visible_tools
            .iter()
            .map(|tool| tool.name)
            .collect()
    }

    fn error(
        &self,
        code: &'static str,
        message: String,
        retryable: bool,
        details: Option<Value>,
    ) -> ToolRouteError {
        ToolRouteError {
            code,
            message,
            retryable,
            details: details.map(|mut value| {
                if let Some(object) = value.as_object_mut() {
                    object.insert(
                        "toolPlanFingerprint".to_string(),
                        json!(self.plan.fingerprint.clone()),
                    );
                }
                value
            }),
        }
    }
}

fn looks_like_complete_html_artifact(content: &str) -> bool {
    let trimmed = content.trim_start();
    let lower_start = trimmed
        .chars()
        .take(256)
        .collect::<String>()
        .to_ascii_lowercase();
    let lower_end = content
        .chars()
        .rev()
        .take(512)
        .collect::<String>()
        .chars()
        .rev()
        .collect::<String>()
        .to_ascii_lowercase();
    (lower_start.starts_with("<!doctype html") || lower_start.starts_with("<html"))
        && lower_start.contains("<html")
        && lower_end.contains("</html>")
}

fn html_artifact_filename(content: &str) -> String {
    let title = extract_html_title(content).unwrap_or("script-package");
    let stem = storage_safe_file_stem(title);
    let stem = stem.trim_matches('-');
    if stem.is_empty() || stem == "root" {
        "script-package.html".to_string()
    } else {
        format!("{stem}.html")
    }
}

fn extract_html_title(content: &str) -> Option<&str> {
    let lower = content.to_ascii_lowercase();
    let start = lower.find("<title>")?;
    let title_start = start + "<title>".len();
    let relative_end = lower[title_start..].find("</title>")?;
    let title = content[title_start..title_start + relative_end].trim();
    (!title.is_empty()).then_some(title)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::tool_inventory::{McpToolInfo, McpToolInventorySnapshot};
    use crate::tools::plan::{build_tool_registry_plan, ToolRegistryPlanParams};

    #[test]
    fn router_normalizes_redbox_image_calls() {
        let plan = build_tool_registry_plan(ToolRegistryPlanParams {
            runtime_mode: "image-generation",
            ..ToolRegistryPlanParams::default()
        });
        let router = ToolRouter::new(plan);
        let prepared = router
            .prepare(
                "Operate",
                &json!({
                    "resource": "image",
                    "operation": "generate",
                    "input": { "prompt": "cover" }
                }),
            )
            .expect("prepare");

        assert_eq!(prepared.name, "workflow");
        assert_eq!(
            prepared.arguments.get("action"),
            Some(&json!("image.generate"))
        );
    }

    #[test]
    fn router_prepares_capture_operate_run() {
        let plan = build_tool_registry_plan(ToolRegistryPlanParams {
            runtime_mode: "redclaw",
            ..ToolRegistryPlanParams::default()
        });
        let router = ToolRouter::new(plan);
        let prepared = router
            .prepare(
                "Operate",
                &json!({
                    "resource": "capture",
                    "operation": "run",
                    "input": {
                        "url": "http://xhslink.com/o/6ea4DsyOJtR",
                        "platform": "auto",
                        "target": "content",
                        "ingestToKnowledge": true
                    }
                }),
            )
            .expect("capture run should prepare");

        assert_eq!(prepared.name, "workflow");
        assert_eq!(
            prepared.arguments.get("action"),
            Some(&json!("capture.collect"))
        );
        assert_eq!(
            prepared.arguments.pointer("/payload/url"),
            Some(&json!("http://xhslink.com/o/6ea4DsyOJtR"))
        );
    }

    #[test]
    fn router_prepares_workspace_write_operate_as_resource_tool() {
        let plan = build_tool_registry_plan(ToolRegistryPlanParams {
            runtime_mode: "redclaw",
            ..ToolRegistryPlanParams::default()
        });
        let router = ToolRouter::new(plan);
        let prepared = router
            .prepare(
                "Operate",
                &json!({
                    "resource": "workspace",
                    "operation": "write",
                    "input": {
                        "path": "workspace://drafts/beav-script.md",
                        "content": "# Beav"
                    }
                }),
            )
            .expect("workspace write should prepare through resource");

        assert_eq!(prepared.name, "resource");
        assert_eq!(
            prepared.arguments.get("action"),
            Some(&json!("workspace.write"))
        );
        assert_eq!(
            prepared.arguments.get("path"),
            Some(&json!("drafts/beav-script.md"))
        );
    }

    #[test]
    fn router_recovers_structured_capture_operate_nested_under_workflow_payload() {
        let plan = build_tool_registry_plan(ToolRegistryPlanParams {
            runtime_mode: "redclaw",
            ..ToolRegistryPlanParams::default()
        });
        let router = ToolRouter::new(plan);
        let prepared = router
            .prepare(
                "workflow",
                &json!({
                    "command": "help",
                    "payload": {
                        "resource": "capture",
                        "operation": "collect",
                        "input": {
                            "url": "http://xhslink.com/o/6ea4DsyOJtR",
                            "platform": "auto",
                            "ingestToKnowledge": true
                        }
                    }
                }),
            )
            .expect("nested structured capture payload should prepare");

        assert_eq!(prepared.name, "workflow");
        assert_eq!(
            prepared.arguments.get("action"),
            Some(&json!("capture.collect"))
        );
        assert_eq!(
            prepared.arguments.pointer("/payload/url"),
            Some(&json!("http://xhslink.com/o/6ea4DsyOJtR"))
        );
    }

    #[test]
    fn router_canonicalizes_legacy_asset_update_before_action_allowlist() {
        let plan = build_tool_registry_plan(ToolRegistryPlanParams {
            runtime_mode: "redclaw",
            ..ToolRegistryPlanParams::default()
        });
        let router = ToolRouter::new(plan);
        let prepared = router
            .prepare(
                "workflow",
                &json!({
                    "action": "asset.update",
                    "payload": {
                        "id": "asset-1",
                        "name": "护综308知识点干货"
                    }
                }),
            )
            .expect("legacy asset update should prepare through assets.manage");

        assert_eq!(prepared.name, "workflow");
        assert_eq!(
            prepared.arguments.get("action"),
            Some(&json!("assets.manage"))
        );
        assert_eq!(
            prepared.arguments.pointer("/payload/operation"),
            Some(&json!("update"))
        );
        assert_eq!(
            prepared.arguments.pointer("/__compat/legacyCommand"),
            Some(&json!("asset.update"))
        );
    }

    #[test]
    fn router_canonicalizes_legacy_asset_category_create_before_action_allowlist() {
        let plan = build_tool_registry_plan(ToolRegistryPlanParams {
            runtime_mode: "redclaw",
            ..ToolRegistryPlanParams::default()
        });
        let router = ToolRouter::new(plan);
        let prepared = router
            .prepare(
                "workflow",
                &json!({
                    "action": "asset.categories.create",
                    "payload": { "name": "择校&备考经验" }
                }),
            )
            .expect("legacy category create should prepare through assets.manage");

        assert_eq!(prepared.name, "workflow");
        assert_eq!(
            prepared.arguments.get("action"),
            Some(&json!("assets.manage"))
        );
        assert_eq!(
            prepared.arguments.pointer("/payload/operation"),
            Some(&json!("category.create"))
        );
        assert_eq!(
            prepared.arguments.pointer("/payload/name"),
            Some(&json!("择校&备考经验"))
        );
    }

    #[test]
    fn router_canonicalizes_legacy_spaces_create_before_action_allowlist() {
        let plan = build_tool_registry_plan(ToolRegistryPlanParams {
            runtime_mode: "redclaw",
            ..ToolRegistryPlanParams::default()
        });
        let router = ToolRouter::new(plan);
        let prepared = router
            .prepare(
                "workflow",
                &json!({
                    "action": "spaces.create",
                    "payload": { "name": "护理考研账号" }
                }),
            )
            .expect("legacy spaces create should prepare through spaces.manage");

        assert_eq!(prepared.name, "workflow");
        assert_eq!(
            prepared.arguments.get("action"),
            Some(&json!("spaces.manage"))
        );
        assert_eq!(
            prepared.arguments.pointer("/payload/operation"),
            Some(&json!("create"))
        );
        assert_eq!(
            prepared.arguments.pointer("/payload/name"),
            Some(&json!("护理考研账号"))
        );
    }

    #[test]
    fn router_prepares_direct_web_search_operate() {
        let plan = build_tool_registry_plan(ToolRegistryPlanParams {
            runtime_mode: "redclaw",
            ..ToolRegistryPlanParams::default()
        });
        let router = ToolRouter::new(plan);
        let prepared = router
            .prepare(
                "Operate",
                &json!({
                    "resource": "web",
                    "operation": "search",
                    "input": { "query": "SpaceX valuation today" }
                }),
            )
            .expect("web search should prepare");

        assert_eq!(prepared.name, "workflow");
        assert_eq!(prepared.arguments.get("action"), Some(&json!("web.search")));
        assert_eq!(
            prepared
                .arguments
                .get("payload")
                .and_then(Value::as_object)
                .and_then(|payload| payload.get("query")),
            Some(&json!("SpaceX valuation today"))
        );
    }

    #[test]
    fn router_prepares_knowledge_create_operate_as_resource_tool() {
        let plan = build_tool_registry_plan(ToolRegistryPlanParams {
            runtime_mode: "redclaw",
            ..ToolRegistryPlanParams::default()
        });
        let router = ToolRouter::new(plan);
        let prepared = router
            .prepare(
                "Operate",
                &json!({
                    "resource": "knowledge",
                    "operation": "create",
                    "input": {
                        "title": "图像提示词",
                        "content": "portrait prompt"
                    }
                }),
            )
            .expect("knowledge create should prepare");

        assert_eq!(prepared.name, "resource");
        assert_eq!(
            prepared.arguments.get("action"),
            Some(&json!("knowledge.create"))
        );
        assert_eq!(
            prepared.arguments.get("content"),
            Some(&json!("portrait prompt"))
        );
    }

    #[test]
    fn router_prepares_profile_get_operate_with_input_doc_type() {
        let plan = build_tool_registry_plan(ToolRegistryPlanParams {
            runtime_mode: "redclaw",
            ..ToolRegistryPlanParams::default()
        });
        let router = ToolRouter::new(plan);
        let prepared = router
            .prepare(
                "Operate",
                &json!({
                    "resource": "profile",
                    "operation": "get",
                    "input": { "docType": "creator_profile" }
                }),
            )
            .expect("profile get should prepare");

        assert_eq!(prepared.name, "workflow");
        assert_eq!(
            prepared.arguments.get("action"),
            Some(&json!("redclaw.profile.read"))
        );
        assert_eq!(
            prepared.arguments.pointer("/payload/docType"),
            Some(&json!("creator_profile"))
        );
    }

    #[test]
    fn router_prepares_profile_update_operate_with_input_payload() {
        let plan = build_tool_registry_plan(ToolRegistryPlanParams {
            runtime_mode: "redclaw",
            ..ToolRegistryPlanParams::default()
        });
        let router = ToolRouter::new(plan);
        let prepared = router
            .prepare(
                "Operate",
                &json!({
                    "resource": "profile",
                    "operation": "update",
                    "input": {
                        "docType": "creator_profile",
                        "markdown": "# CreatorProfile.md\n\n## 定位总览"
                    }
                }),
            )
            .expect("profile update should prepare");

        assert_eq!(prepared.name, "workflow");
        assert_eq!(
            prepared.arguments.get("action"),
            Some(&json!("profile.manage"))
        );
        assert_eq!(
            prepared.arguments.pointer("/payload/operation"),
            Some(&json!("update"))
        );
        assert_eq!(
            prepared.arguments.pointer("/payload/docType"),
            Some(&json!("creator_profile"))
        );
        assert_eq!(
            prepared.arguments.pointer("/payload/markdown"),
            Some(&json!("# CreatorProfile.md\n\n## 定位总览"))
        );
    }

    #[test]
    fn router_normalizes_voice_speech_operate_to_completed_audio_job() {
        let plan = build_tool_registry_plan(ToolRegistryPlanParams {
            runtime_mode: "redclaw",
            ..ToolRegistryPlanParams::default()
        });
        let router = ToolRouter::new(plan);
        let prepared = router
            .prepare(
                "Operate",
                &json!({
                    "resource": "voice",
                    "operation": "speech",
                    "input": {
                        "voiceId": "voice_2eee156a6468427bb185a831",
                        "input": "君不见黄河之水天上来。",
                        "title": "将进酒-Jamba朗诵"
                    }
                }),
            )
            .expect("voice speech should prepare");

        assert_eq!(prepared.name, "workflow");
        assert_eq!(
            prepared.arguments.get("action"),
            Some(&json!("voice.speech"))
        );
        let payload = prepared
            .arguments
            .get("payload")
            .and_then(Value::as_object)
            .expect("payload should exist");
        assert_eq!(
            payload.get("voiceId"),
            Some(&json!("voice_2eee156a6468427bb185a831"))
        );
        assert_eq!(payload.get("input"), Some(&json!("君不见黄河之水天上来。")));
        assert_eq!(payload.get("waitForCompletion"), Some(&json!(true)));
    }

    #[test]
    fn router_rejects_legacy_tool_aliases_by_default() {
        let plan = build_tool_registry_plan(ToolRegistryPlanParams {
            runtime_mode: "image-generation",
            ..ToolRegistryPlanParams::default()
        });
        let router = ToolRouter::new(plan);
        let error = router
            .prepare(
                "Redbox",
                &json!({
                    "resource": "image",
                    "operation": "generate",
                    "input": { "prompt": "cover" }
                }),
            )
            .expect_err("legacy alias should be disabled");

        assert!(error.contains("LEGACY_TOOL_ALIAS_DISABLED"));
        assert!(error.contains("Operate"));
    }

    #[test]
    fn router_rejects_legacy_workflow_commands_by_default() {
        let plan = build_tool_registry_plan(ToolRegistryPlanParams {
            runtime_mode: "team",
            ..ToolRegistryPlanParams::default()
        });
        let router = ToolRouter::new(plan);
        let error = router
            .prepare("workflow", &json!({ "command": "help" }))
            .expect_err("legacy command should be disabled");

        assert!(error.contains("LEGACY_COMMAND_DISABLED"));
    }

    #[test]
    fn router_prepares_visible_shell_tool() {
        let plan = build_tool_registry_plan(ToolRegistryPlanParams {
            runtime_mode: "redclaw",
            ..ToolRegistryPlanParams::default()
        });
        let router = ToolRouter::new(plan);
        let prepared = router
            .prepare("shell", &json!({ "command": "pwd" }))
            .expect("visible shell tool should be routable");

        assert_eq!(prepared.name, "shell");
        assert_eq!(prepared.arguments.get("command"), Some(&json!("pwd")));
    }

    #[test]
    fn router_rejects_empty_operate_with_missing_fields() {
        let plan = build_tool_registry_plan(ToolRegistryPlanParams {
            runtime_mode: "redclaw",
            ..ToolRegistryPlanParams::default()
        });
        let router = ToolRouter::new(plan);
        let error = router
            .prepare("Operate", &json!({}))
            .expect_err("empty Operate should fail");

        assert!(error.contains("EMPTY_OPERATE_CALL"));
        assert!(error.contains("resource"));
        assert!(error.contains("operation"));
    }

    #[test]
    fn router_recovers_unbound_write_complete_html_to_workspace_write() {
        let plan = build_tool_registry_plan(ToolRegistryPlanParams {
            runtime_mode: "redclaw",
            ..ToolRegistryPlanParams::default()
        });
        let router = ToolRouter::new(plan);
        let prepared = router
            .prepare(
                "Write",
                &json!({
                    "content": "<!doctype html><html><head><title>Beav Intro Video Script</title></head><body><h1>Beav</h1></body></html>"
                }),
            )
            .expect("complete standalone html should recover to workspace.write");

        assert_eq!(prepared.name, "resource");
        assert_eq!(
            prepared.arguments.get("action"),
            Some(&json!("workspace.write"))
        );
        assert_eq!(
            prepared.arguments.get("path"),
            Some(&json!("manuscripts/Beav Intro Video Script.html"))
        );
        assert_eq!(
            prepared.arguments.pointer("/__compat/legacyToolName"),
            Some(&json!("Write"))
        );
        assert_eq!(
            prepared.arguments.pointer("/writeRecoveryDecision/reason"),
            Some(&json!("unbound_write_complete_html_artifact"))
        );
    }

    #[test]
    fn router_rejects_operate_manuscript_write_current_with_write_hint() {
        let plan = build_tool_registry_plan(ToolRegistryPlanParams {
            runtime_mode: "redclaw",
            ..ToolRegistryPlanParams::default()
        });
        let router = ToolRouter::new(plan);
        let error = router
            .prepare(
                "Operate",
                &json!({
                    "resource": "manuscripts",
                    "operation": "writeCurrent",
                    "input": { "content": "body" }
                }),
            )
            .expect_err("Operate writeCurrent should fail");

        assert!(error.contains("MANUSCRIPT_WRITE_REQUIRES_WRITE"));
        assert!(error.contains("manuscripts://current"));
    }

    #[test]
    fn router_rejects_deferred_manuscript_create_for_standalone_artifact() {
        let plan = build_tool_registry_plan(ToolRegistryPlanParams {
            runtime_mode: "redclaw",
            ..ToolRegistryPlanParams::default()
        });
        let router = ToolRouter::new(plan);
        let error = router
            .prepare(
                "Operate",
                &json!({
                    "resource": "manuscript",
                    "operation": "create",
                    "input": {
                        "path": "manuscripts://current",
                        "source": "ai"
                    }
                }),
            )
            .expect_err("standalone artifact should not create manuscript project");

        assert!(error.contains("MANUSCRIPT_PROJECT_NOT_NEEDED_FOR_STANDALONE_ARTIFACT"));
        assert!(error.contains("workspace.write"));
        assert!(!error.contains("ACTION_DEFERRED"));
    }

    #[test]
    fn router_allows_write_current_via_write_without_direct_operate_action() {
        let metadata = json!({
            "executionProfile": "artifact-authoring",
            "artifactType": "manuscript",
            "allowedTools": ["resource", "workflow"],
            "allowedOperateActions": [
                "skills.invoke",
                "manuscripts.createProject",
                "redclaw.profile.read",
                "redclaw.profile.bundle"
            ],
            "allowedWriteTargets": ["manuscripts://current"],
            "deferredDiscovery": false
        });
        let plan = build_tool_registry_plan(ToolRegistryPlanParams {
            runtime_mode: "redclaw",
            session_metadata: Some(&metadata),
            ..ToolRegistryPlanParams::default()
        });
        let router = ToolRouter::new(plan);
        let prepared = router
            .prepare(
                "Write",
                &json!({ "path": "manuscripts://current", "content": "body" }),
            )
            .expect("Write should route internally to manuscript save");

        assert_eq!(prepared.name, "workflow");
        assert_eq!(
            prepared.arguments.get("action"),
            Some(&json!("manuscripts.writeCurrent"))
        );
    }

    #[test]
    fn router_allows_read_current_manuscript_in_authoring_sessions() {
        let metadata = json!({
            "executionProfile": "artifact-authoring",
            "artifactType": "manuscript",
            "allowedTools": ["resource", "workflow"],
            "allowedOperateActions": [
                "skills.invoke",
                "manuscripts.createProject"
            ],
            "allowedWriteTargets": ["manuscripts://current"],
            "deferredDiscovery": false
        });
        let plan = build_tool_registry_plan(ToolRegistryPlanParams {
            runtime_mode: "redclaw",
            session_metadata: Some(&metadata),
            ..ToolRegistryPlanParams::default()
        });
        let router = ToolRouter::new(plan);
        let prepared = router
            .prepare("Read", &json!({ "path": "manuscripts://current" }))
            .expect("Read current manuscript should route in authoring session");

        assert_eq!(prepared.name, "workflow");
        assert_eq!(
            prepared.arguments.get("action"),
            Some(&json!("manuscripts.readCurrent"))
        );
    }

    #[test]
    fn router_allows_reading_listed_manuscript_paths_by_default() {
        let plan = build_tool_registry_plan(ToolRegistryPlanParams {
            runtime_mode: "redclaw",
            ..ToolRegistryPlanParams::default()
        });
        let router = ToolRouter::new(plan);
        let prepared = router
            .prepare("Read", &json!({ "path": "manuscripts://wander/demo" }))
            .expect("Read should route listed manuscript paths");

        assert_eq!(prepared.name, "workflow");
        assert_eq!(
            prepared.arguments.get("action"),
            Some(&json!("manuscripts.read"))
        );
        assert_eq!(
            prepared.arguments.pointer("/payload/path"),
            Some(&json!("wander/demo"))
        );
    }

    #[test]
    fn router_rejects_workspace_write_with_structured_action_hint() {
        let metadata = json!({
            "executionProfile": "artifact-authoring",
            "artifactType": "manuscript",
            "allowedTools": ["resource", "workflow"],
            "allowedOperateActions": [
                "skills.invoke",
                "manuscripts.createProject"
            ],
            "allowedWriteTargets": ["manuscripts://current"],
            "deferredDiscovery": false
        });
        let plan = build_tool_registry_plan(ToolRegistryPlanParams {
            runtime_mode: "redclaw",
            session_metadata: Some(&metadata),
            ..ToolRegistryPlanParams::default()
        });
        let router = ToolRouter::new(plan);
        let error = router
            .prepare(
                "Write",
                &json!({ "path": "workspace://test_write.md", "content": "body" }),
            )
            .expect_err("workspace writes should not route through Write");

        assert!(error.contains("WRITE_TARGET_NOT_ALLOWED"));
        assert!(error.contains("unsupportedScheme"));
        assert!(error.contains("workspace.write"));
        assert!(error.contains("test_write.md"));

        let router_without_write_targets =
            ToolRouter::new(build_tool_registry_plan(ToolRegistryPlanParams {
                runtime_mode: "redclaw",
                ..ToolRegistryPlanParams::default()
            }));
        let fallback_error = router_without_write_targets
            .prepare(
                "Write",
                &json!({ "path": "workspace://notes/demo.md", "content": "body" }),
            )
            .expect_err("workspace writes should always avoid Write");

        assert!(fallback_error.contains("WRITE_TARGET_NOT_ALLOWED"));
        assert!(fallback_error.contains("workspace.write"));
        assert!(fallback_error.contains("notes/demo.md"));
    }

    #[test]
    fn router_allows_profile_read_compat_alias_when_canonical_profile_read_is_direct() {
        let metadata = json!({
            "executionProfile": "artifact-authoring",
            "artifactType": "manuscript",
            "allowedTools": ["resource", "workflow"],
            "allowedOperateActions": [
                "taskBrief.update",
                "skills.invoke",
                "manuscripts.createProject",
                "profile.read"
            ],
            "allowedWriteTargets": ["manuscripts://current"],
            "deferredDiscovery": false
        });
        let plan = build_tool_registry_plan(ToolRegistryPlanParams {
            runtime_mode: "redclaw",
            session_metadata: Some(&metadata),
            ..ToolRegistryPlanParams::default()
        });
        let router = ToolRouter::new(plan);
        let prepared = router
            .prepare("Read", &json!({ "path": "profiles://user" }))
            .expect("profile read compat alias should be accepted");

        assert_eq!(prepared.name, "workflow");
        assert_eq!(
            prepared.arguments.get("action"),
            Some(&json!("redclaw.profile.read"))
        );
    }

    #[test]
    fn router_recovers_task_brief_update_from_operate_input_wrapper() {
        let metadata = json!({
            "executionProfile": "artifact-authoring",
            "artifactType": "manuscript",
            "allowedTools": ["resource", "workflow"],
            "allowedOperateActions": ["taskBrief.update"],
            "deferredDiscovery": false
        });
        let plan = build_tool_registry_plan(ToolRegistryPlanParams {
            runtime_mode: "redclaw",
            session_metadata: Some(&metadata),
            ..ToolRegistryPlanParams::default()
        });
        let router = ToolRouter::new(plan);
        let prepared = router
            .prepare(
                "Operate",
                &json!({
                    "input": {
                        "resource": "taskBrief",
                        "operation": "update",
                        "input": {
                            "brief": { "currentStage": "init" },
                            "stage": "init",
                            "status": "in_progress"
                        }
                    }
                }),
            )
            .expect("wrapped taskBrief update should be accepted");

        assert_eq!(prepared.name, "workflow");
        assert_eq!(
            prepared.arguments.get("action"),
            Some(&json!("taskBrief.update"))
        );
    }

    #[test]
    fn router_rejects_deferred_actions() {
        let plan = build_tool_registry_plan(ToolRegistryPlanParams {
            runtime_mode: "image-generation",
            ..ToolRegistryPlanParams::default()
        });
        let router = ToolRouter::new(plan);
        let error = router
            .prepare(
                "workflow",
                &json!({ "action": "manuscripts.createProject", "payload": {} }),
            )
            .expect_err("deferred action should fail");

        assert!(error.contains("ACTION_DEFERRED"));
        assert!(error.contains("tool_search"));
    }

    #[test]
    fn router_routes_team_session_create_to_consolidated_team_control() {
        let plan = build_tool_registry_plan(ToolRegistryPlanParams {
            runtime_mode: "redclaw",
            ..ToolRegistryPlanParams::default()
        });
        let router = ToolRouter::new(plan);
        let prepared = router
            .prepare(
                "Operate",
                &json!({
                    "resource": "team.session",
                    "operation": "create",
                    "input": {
                        "title": "Video team",
                        "objective": "Create videos",
                        "userConfirmedTeamPlan": true
                    }
                }),
            )
            .expect("team.session.create should route through consolidated team.control");

        assert_eq!(prepared.name, "workflow");
        assert_eq!(
            prepared.arguments.get("action"),
            Some(&json!("team.control"))
        );
        assert_eq!(
            prepared.arguments.pointer("/payload/operation"),
            Some(&json!("session.create"))
        );
        assert_eq!(
            prepared.arguments.pointer("/__compat/legacyCommand"),
            Some(&json!("team.session.create"))
        );
    }

    #[test]
    fn router_prepares_task_create_operate_without_legacy_workflow_error() {
        let plan = build_tool_registry_plan(ToolRegistryPlanParams {
            runtime_mode: "redclaw",
            ..ToolRegistryPlanParams::default()
        });
        let router = ToolRouter::new(plan);
        let prepared = router
            .prepare(
                "Operate",
                &json!({
                    "resource": "task",
                    "operation": "create",
                    "input": {
                        "name": "每日早间新闻简报",
                        "cron": "0 8 * * *",
                        "ownerScope": "current_space",
                        "actionType": "资讯简报",
                        "prompt": "每天早上汇总当天重要新闻"
                    }
                }),
            )
            .expect("task create should route to consolidated task.manage");

        assert_eq!(prepared.name, "workflow");
        assert_eq!(
            prepared.arguments.get("action"),
            Some(&json!("task.manage"))
        );
        assert_eq!(
            prepared.arguments.pointer("/payload/operation"),
            Some(&json!("create"))
        );
        assert_eq!(prepared.arguments.get("command"), None);
    }

    #[test]
    fn router_prepares_direct_team_guide_operate() {
        let plan = build_tool_registry_plan(ToolRegistryPlanParams {
            runtime_mode: "redclaw",
            ..ToolRegistryPlanParams::default()
        });
        let router = ToolRouter::new(plan);
        let prepared = router
            .prepare(
                "Operate",
                &json!({
                    "resource": "team.guide",
                    "operation": "create",
                    "input": {
                        "name": "Video content team",
                        "summary": "Create short-form video content",
                        "members": [],
                        "tasks": [],
                        "userConfirmedTeamPlan": true,
                        "autoOpen": true
                    }
                }),
            )
            .expect("team guide create should be direct");

        assert_eq!(prepared.name, "workflow");
        assert_eq!(
            prepared.arguments.get("action"),
            Some(&json!("team.guide.create"))
        );
    }

    #[test]
    fn router_prepares_direct_mcp_tool_without_compat_normalization() {
        let inventory = McpToolInventorySnapshot {
            tools: vec![McpToolInfo {
                server_id: "demo".to_string(),
                server_name: "Demo".to_string(),
                raw_tool_name: "read".to_string(),
                callable_name: "mcp__demo__read".to_string(),
                ..McpToolInfo::default()
            }],
            fingerprint: "mcp-a".to_string(),
        };
        let plan = build_tool_registry_plan(ToolRegistryPlanParams {
            runtime_mode: "team",
            session_metadata: Some(&json!({ "maxDirectMcpTools": 4 })),
            mcp_inventory: Some(&inventory),
            ..ToolRegistryPlanParams::default()
        });
        let router = ToolRouter::new(plan);
        let prepared = router
            .prepare("mcp__demo__read", &json!({ "uri": "memo://1" }))
            .expect("prepare mcp");

        assert_eq!(prepared.name, "mcp__demo__read");
        assert_eq!(
            prepared
                .mcp_tool
                .as_ref()
                .map(|tool| tool.raw_tool_name.as_str()),
            Some("read")
        );
    }

    #[test]
    fn router_rejects_deferred_mcp_tools_with_search_hint() {
        let inventory = McpToolInventorySnapshot {
            tools: (0..30)
                .map(|index| McpToolInfo {
                    server_id: "demo".to_string(),
                    server_name: "Demo".to_string(),
                    raw_tool_name: format!("t{index}"),
                    callable_name: format!("mcp__demo__t{index}"),
                    ..McpToolInfo::default()
                })
                .collect(),
            fingerprint: "mcp-a".to_string(),
        };
        let plan = build_tool_registry_plan(ToolRegistryPlanParams {
            runtime_mode: "team",
            mcp_inventory: Some(&inventory),
            ..ToolRegistryPlanParams::default()
        });
        let router = ToolRouter::new(plan);
        let error = router
            .prepare("mcp__demo__t1", &json!({}))
            .expect_err("deferred mcp tool should fail");

        assert!(error.contains("TOOL_DEFERRED"));
        assert!(error.contains("tool_search"));
    }

    #[test]
    fn router_prepares_mcp_resource_tools_when_mcp_is_enabled() {
        let inventory = McpToolInventorySnapshot {
            tools: vec![McpToolInfo {
                server_id: "demo".to_string(),
                server_name: "Demo".to_string(),
                raw_tool_name: "read".to_string(),
                callable_name: "mcp__demo__read".to_string(),
                ..McpToolInfo::default()
            }],
            fingerprint: "mcp-a".to_string(),
        };
        let plan = build_tool_registry_plan(ToolRegistryPlanParams {
            runtime_mode: "team",
            mcp_inventory: Some(&inventory),
            ..ToolRegistryPlanParams::default()
        });
        let router = ToolRouter::new(plan);
        let prepared = router
            .prepare(
                "read_mcp_resource",
                &json!({ "serverId": "demo", "uri": "memo://1" }),
            )
            .expect("prepare resource tool");

        assert_eq!(prepared.name, "read_mcp_resource");
        assert_eq!(
            prepared.mcp_resource,
            Some(McpResourcePreparedCall::ReadResource)
        );
        assert!(router.supports_parallel(&prepared));
    }
}
