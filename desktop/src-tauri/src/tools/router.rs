use crate::mcp::McpToolInfo;
use serde_json::{json, Value};

use crate::payload_string;
use crate::tools::catalog::descriptor_by_name;
use crate::tools::compat::{canonical_tool_name, is_legacy_tool_alias, normalize_tool_call};
use crate::tools::plan::ToolRegistryPlan;

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
        if normalized_name == "workflow" {
            self.ensure_app_cli_action_allowed(&normalized_call.arguments)?;
        }
        Ok(PreparedToolCall {
            name: normalized_name.to_string(),
            arguments: normalized_call.arguments,
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
        let resource = object
            .get("resource")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or_default();
        let operation = object
            .get("operation")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or_default();
        if resource.is_empty() || operation.is_empty() {
            return Err(self
                .error(
                    "MISSING_OPERATE_FIELDS",
                    "Operate requires non-empty resource and operation fields".to_string(),
                    false,
                    Some(json!({
                        "requiredFields": ["resource", "operation"],
                        "receivedFields": object.keys().collect::<Vec<_>>(),
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

    fn validate_write_call(&self, arguments: &Value) -> Result<(), String> {
        if self.plan.allowed_write_targets.is_empty() {
            return Ok(());
        }
        let path = arguments
            .get("path")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or_default();
        if self
            .plan
            .allowed_write_targets
            .iter()
            .any(|target| target == path)
        {
            return Ok(());
        }
        Err(self
            .error(
                "WRITE_TARGET_NOT_ALLOWED",
                format!("Write target `{path}` is not available in this turn"),
                false,
                Some(json!({
                    "allowedWriteTargets": self.plan.allowed_write_targets.clone(),
                    "visibleTools": self.visible_tool_names(),
                })),
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
    fn router_rejects_empty_operate_with_missing_fields() {
        let plan = build_tool_registry_plan(ToolRegistryPlanParams {
            runtime_mode: "redclaw",
            ..ToolRegistryPlanParams::default()
        });
        let router = ToolRouter::new(plan);
        let error = router
            .prepare("Operate", &json!({}))
            .expect_err("empty Operate should fail");

        assert!(error.contains("MISSING_OPERATE_FIELDS"));
        assert!(error.contains("resource"));
        assert!(error.contains("operation"));
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
