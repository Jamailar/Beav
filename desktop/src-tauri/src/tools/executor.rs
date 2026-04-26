use serde_json::{json, Value};
use tauri::{AppHandle, State};

use crate::events::emit_runtime_event;
use crate::mcp::config::{
    effective_server_config, effective_server_records, mcp_tool_requires_approval,
};
use crate::mcp::{resource_templates_from_response, resources_from_response};
use crate::persistence::{with_store, with_store_mut};
use crate::runtime::{
    append_session_checkpoint, request_runtime_approval, runtime_approval_confirmed_by_call_id,
    RuntimeApprovalDetails, RuntimeApprovalRecord,
};
use crate::tools::plan::build_tool_registry_plan_for_session_with_mcp;
use crate::tools::router::{McpResourcePreparedCall, PreparedToolCall, ToolRouter};
use crate::{append_session_transcript, AppState};

pub struct InteractiveToolExecutor<'a> {
    app: &'a AppHandle,
    state: &'a State<'a, AppState>,
    runtime_mode: &'a str,
    session_id: Option<&'a str>,
    tool_call_id: Option<&'a str>,
}

impl<'a> InteractiveToolExecutor<'a> {
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

    pub fn prepare_tool_call(
        &self,
        name: &str,
        arguments: &Value,
    ) -> Result<PreparedToolCall, String> {
        let mcp_servers = with_store(self.state, |store| Ok(store.mcp_servers.clone()))?;
        let mcp_inventory = self.state.mcp_manager.list_all_tools(&mcp_servers).ok();
        let plan = with_store(self.state, |store| {
            Ok(build_tool_registry_plan_for_session_with_mcp(
                &store,
                self.runtime_mode,
                self.session_id,
                mcp_inventory.as_ref(),
            ))
        })?;
        ToolRouter::new(plan).prepare(name, arguments)
    }

    pub fn dispatch_action_tool(
        &self,
        prepared: &PreparedToolCall,
    ) -> Option<Result<Value, String>> {
        match prepared.name.as_str() {
            "app_cli" => Some(self.execute_app_cli(&prepared.arguments)),
            "bash" => Some(self.execute_bash(&prepared.arguments)),
            _ => None,
        }
    }

    pub fn dispatch_mcp_tool(&self, prepared: &PreparedToolCall) -> Option<Result<Value, String>> {
        let tool = prepared.mcp_tool.clone()?;
        Some((|| {
            let mcp_servers = with_store(self.state, |store| Ok(store.mcp_servers.clone()))?;
            let server = mcp_servers
                .iter()
                .find(|server| server.id == tool.server_id)
                .cloned()
                .ok_or_else(|| format!("MCP server `{}` is not configured", tool.server_id))?;
            let call_id = self.tool_call_id.unwrap_or(prepared.name.as_str());
            let effective_config = effective_server_config(&server);
            if mcp_tool_requires_approval(&server, &tool.raw_tool_name, tool.destructive)
                && !runtime_approval_confirmed_by_call_id(self.state, call_id)?
            {
                let approval_id =
                    format!("mcp:{}:{}:{}", tool.server_id, tool.raw_tool_name, call_id);
                let approval = request_runtime_approval(
                    self.state,
                    RuntimeApprovalRecord::pending(
                        approval_id.clone(),
                        "mcp_tool",
                        approval_id.clone(),
                        prepared.name.clone(),
                        RuntimeApprovalDetails {
                            r#type: "mcp_tool".to_string(),
                            title: format!("调用 MCP 工具 {}", tool.raw_tool_name),
                            description: format!(
                                "{} 将调用 MCP server {} 的工具 {}",
                                prepared.name, tool.server_name, tool.raw_tool_name
                            ),
                            impact: Some(if tool.destructive {
                                "该 MCP 工具声明为 destructive，可能修改外部系统或本地数据。"
                                    .to_string()
                            } else {
                                "该 MCP server 策略要求调用前确认。".to_string()
                            }),
                        },
                    )
                    .with_scope(self.session_id, None, None, Some(call_id))
                    .with_metadata(Some(json!({
                        "serverId": tool.server_id,
                        "serverName": tool.server_name,
                        "rawToolName": tool.raw_tool_name,
                        "callableName": tool.callable_name,
                        "approvalMode": effective_config.policy.approval_mode,
                    }))),
                )?;
                emit_runtime_event(
                    self.app,
                    "runtime:mcp-tool-approval-required",
                    self.session_id,
                    None,
                    json!({
                        "callId": call_id,
                        "toolName": prepared.name,
                        "serverId": tool.server_id,
                        "serverName": tool.server_name,
                        "rawToolName": tool.raw_tool_name,
                        "approval": approval,
                    }),
                );
                self.record_mcp_marker(
                    "mcp.tool.approval_required",
                    call_id,
                    &prepared.name,
                    false,
                    json!({
                        "serverId": tool.server_id,
                        "serverName": tool.server_name,
                        "rawToolName": tool.raw_tool_name,
                        "approval": approval,
                    }),
                );
                return Err(json!({
                    "ok": false,
                    "tool": prepared.name,
                    "error": {
                        "code": "MCP_APPROVAL_REQUIRED",
                        "message": "MCP tool call requires approval before execution",
                        "retryable": true,
                        "approval": approval,
                    }
                })
                .to_string());
            }
            emit_runtime_event(
                self.app,
                "runtime:mcp-tool-start",
                self.session_id,
                None,
                json!({
                    "callId": call_id,
                    "toolName": prepared.name,
                    "serverId": tool.server_id,
                    "serverName": tool.server_name,
                    "rawToolName": tool.raw_tool_name,
                    "toolTimeoutMs": effective_config.tool_timeout_ms,
                }),
            );
            self.record_mcp_marker(
                "mcp.tool.start",
                call_id,
                &prepared.name,
                true,
                json!({
                    "serverId": tool.server_id,
                    "serverName": tool.server_name,
                    "rawToolName": tool.raw_tool_name,
                    "toolTimeoutMs": effective_config.tool_timeout_ms,
                    "elicitationPausesTimeout": effective_config.elicitation_pauses_timeout,
                }),
            );
            let result = match self.state.mcp_manager.call_tool(
                &mcp_servers,
                &tool,
                prepared.arguments.clone(),
            ) {
                Ok(result) => result,
                Err(error) => {
                    emit_runtime_event(
                        self.app,
                        "runtime:mcp-tool-end",
                        self.session_id,
                        None,
                        json!({
                            "callId": call_id,
                            "toolName": prepared.name,
                            "serverId": tool.server_id,
                            "serverName": tool.server_name,
                            "rawToolName": tool.raw_tool_name,
                            "success": false,
                            "error": error.clone(),
                        }),
                    );
                    self.record_mcp_marker(
                        "mcp.tool.end",
                        call_id,
                        &prepared.name,
                        false,
                        json!({
                            "serverId": tool.server_id,
                            "serverName": tool.server_name,
                            "rawToolName": tool.raw_tool_name,
                            "error": error.clone(),
                        }),
                    );
                    return Err(error);
                }
            };
            let payload = json!({
                "success": true,
                "kind": "mcp_tool",
                "serverId": tool.server_id,
                "serverName": tool.server_name,
                "toolName": tool.callable_name,
                "rawToolName": tool.raw_tool_name,
                "policy": effective_config.policy,
                "toolTimeoutMs": effective_config.tool_timeout_ms,
                "response": result.response,
                "session": result.session,
                "capabilities": result.capabilities,
            });
            emit_runtime_event(
                self.app,
                "runtime:mcp-tool-end",
                self.session_id,
                None,
                json!({
                    "callId": call_id,
                    "toolName": prepared.name,
                    "serverId": tool.server_id,
                    "serverName": tool.server_name,
                    "rawToolName": tool.raw_tool_name,
                    "success": true,
                }),
            );
            self.record_mcp_marker(
                "mcp.tool.end",
                call_id,
                &prepared.name,
                true,
                json!({
                    "serverId": tool.server_id,
                    "serverName": tool.server_name,
                    "rawToolName": tool.raw_tool_name,
                    "session": payload.get("session").cloned(),
                    "capabilities": payload.get("capabilities").cloned(),
                }),
            );
            Ok(payload)
        })())
    }

    pub fn dispatch_mcp_resource_tool(
        &self,
        prepared: &PreparedToolCall,
    ) -> Option<Result<Value, String>> {
        let resource_call = prepared.mcp_resource.clone()?;
        Some((|| {
            let mcp_servers = with_store(self.state, |store| Ok(store.mcp_servers.clone()))?;
            let server_id = prepared
                .arguments
                .get("serverId")
                .or_else(|| prepared.arguments.get("server_id"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty());
            let servers = if let Some(server_id) = server_id {
                mcp_servers
                    .iter()
                    .filter(|server| server.id == server_id)
                    .cloned()
                    .collect::<Vec<_>>()
            } else {
                effective_server_records(&mcp_servers)
            };
            let call_id = self.tool_call_id.unwrap_or(prepared.name.as_str());
            emit_runtime_event(
                self.app,
                "runtime:mcp-resource-tool-start",
                self.session_id,
                None,
                json!({
                    "callId": call_id,
                    "toolName": prepared.name,
                    "serverId": server_id,
                }),
            );
            self.record_mcp_marker(
                "mcp.resource.start",
                call_id,
                &prepared.name,
                true,
                json!({ "serverId": server_id }),
            );
            let payload = match resource_call {
                McpResourcePreparedCall::ListResources => {
                    let mut resources = Vec::new();
                    for server in servers {
                        let result = self.state.mcp_manager.list_resources(&server)?;
                        resources.extend(resources_from_response(&server, &result.response));
                    }
                    json!({
                        "success": true,
                        "kind": "mcp_resources",
                        "resources": resources,
                    })
                }
                McpResourcePreparedCall::ListResourceTemplates => {
                    let mut resource_templates = Vec::new();
                    for server in servers {
                        let result = self.state.mcp_manager.list_resource_templates(&server)?;
                        resource_templates
                            .extend(resource_templates_from_response(&server, &result.response));
                    }
                    json!({
                        "success": true,
                        "kind": "mcp_resource_templates",
                        "resourceTemplates": resource_templates,
                    })
                }
                McpResourcePreparedCall::ReadResource => {
                    let Some(server_id) = server_id else {
                        return Err("read_mcp_resource requires serverId".to_string());
                    };
                    let uri = prepared
                        .arguments
                        .get("uri")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                        .ok_or_else(|| "read_mcp_resource requires uri".to_string())?;
                    let server = mcp_servers
                        .iter()
                        .find(|server| server.id == server_id)
                        .ok_or_else(|| format!("MCP server `{server_id}` is not configured"))?;
                    let result = self.state.mcp_manager.read_resource(server, uri)?;
                    json!({
                        "success": true,
                        "kind": "mcp_resource",
                        "serverId": server.id,
                        "serverName": server.name,
                        "uri": uri,
                        "response": result.response,
                        "session": result.session,
                        "capabilities": result.capabilities,
                    })
                }
            };
            emit_runtime_event(
                self.app,
                "runtime:mcp-resource-tool-end",
                self.session_id,
                None,
                json!({
                    "callId": call_id,
                    "toolName": prepared.name,
                    "serverId": server_id,
                    "success": true,
                }),
            );
            self.record_mcp_marker(
                "mcp.resource.end",
                call_id,
                &prepared.name,
                true,
                json!({
                    "serverId": server_id,
                    "kind": payload.get("kind").cloned(),
                }),
            );
            Ok(payload)
        })())
    }

    fn record_mcp_marker(
        &self,
        checkpoint_type: &str,
        call_id: &str,
        tool_name: &str,
        success: bool,
        payload: Value,
    ) {
        let Some(session_id) = self.session_id else {
            return;
        };
        let _ = with_store_mut(self.state, |store| {
            let content = format!(
                "{} {} {}",
                tool_name,
                if success { "ok" } else { "blocked_or_failed" },
                checkpoint_type
            );
            append_session_transcript(
                store,
                session_id,
                checkpoint_type,
                "tool",
                content.clone(),
                Some(json!({
                    "callId": call_id,
                    "toolName": tool_name,
                    "success": success,
                    "payload": payload.clone(),
                })),
            );
            append_session_checkpoint(
                store,
                session_id,
                checkpoint_type,
                content,
                Some(json!({
                    "callId": call_id,
                    "toolName": tool_name,
                    "success": success,
                    "payload": payload,
                })),
            );
            Ok(())
        });
    }

    fn execute_app_cli(&self, arguments: &Value) -> Result<Value, String> {
        crate::tools::app_cli::AppCliExecutor::new(
            self.app,
            self.state,
            self.runtime_mode,
            self.session_id,
            self.tool_call_id,
        )
        .execute(arguments)
    }

    fn execute_bash(&self, arguments: &Value) -> Result<Value, String> {
        crate::tools::bash::execute_bash(arguments, self.state, self.session_id)
    }
}
