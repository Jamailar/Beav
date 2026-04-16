use serde_json::{json, Value};
use tauri::{AppHandle, State};

use crate::commands;
use crate::runtime::McpServerRecord;
use crate::{payload_field, payload_string, AppState};

pub struct PreparedToolCall {
    pub name: &'static str,
    pub arguments: Value,
}

pub struct InteractiveToolExecutor<'a> {
    app: &'a AppHandle,
    state: &'a State<'a, AppState>,
    runtime_mode: &'a str,
    session_id: Option<&'a str>,
}

impl<'a> InteractiveToolExecutor<'a> {
    pub fn new(
        app: &'a AppHandle,
        state: &'a State<'a, AppState>,
        runtime_mode: &'a str,
        session_id: Option<&'a str>,
    ) -> Self {
        Self {
            app,
            state,
            runtime_mode,
            session_id,
        }
    }

    pub fn prepare_tool_call(
        &self,
        name: &str,
        arguments: &Value,
    ) -> Result<PreparedToolCall, String> {
        let normalized_call = crate::tools::compat::normalize_tool_call(name, arguments);
        let normalized_name = normalized_call.name;
        let normalized_arguments = normalized_call.arguments;
        crate::tools::guards::ensure_tool_allowed_for_session(
            self.state,
            self.runtime_mode,
            self.session_id,
            normalized_name,
        )?;
        Ok(PreparedToolCall {
            name: normalized_name,
            arguments: normalized_arguments,
        })
    }

    pub fn dispatch_action_tool(
        &self,
        prepared: &PreparedToolCall,
    ) -> Option<Result<Value, String>> {
        match prepared.name {
            "app_cli" => Some(self.execute_app_cli(&prepared.arguments)),
            "bash" => Some(self.execute_bash(&prepared.arguments)),
            "redbox_mcp" => Some(self.execute_redbox_mcp(&prepared.arguments)),
            "redbox_skill" => Some(self.execute_redbox_skill(&prepared.arguments)),
            "redbox_runtime_control" => {
                Some(self.execute_redbox_runtime_control(&prepared.arguments))
            }
            _ => None,
        }
    }

    fn call_skill_channel(&self, channel: &str, payload: Value) -> Result<Value, String> {
        commands::skills_ai::handle_skills_ai_channel(self.app, self.state, channel, &payload)
            .unwrap_or_else(|| Err(format!("Skill channel not handled: {channel}")))
    }

    fn call_runtime_channel(&self, channel: &str, payload: Value) -> Result<Value, String> {
        commands::runtime::handle_runtime_channel(self.app, self.state, channel, &payload)
            .unwrap_or_else(|| Err(format!("Runtime channel not handled: {channel}")))
    }

    fn call_bridge_channel(&self, channel: &str, payload: Value) -> Result<Value, String> {
        commands::bridge::handle_bridge_channel(self.app, self.state, channel, &payload)
            .unwrap_or_else(|| Err(format!("Bridge channel not handled: {channel}")))
    }

    fn call_chat_channel(&self, channel: &str, payload: Value) -> Result<Value, String> {
        commands::chat_sessions_wander::handle_chat_sessions_wander_channel(
            self.app, self.state, channel, &payload,
        )
        .unwrap_or_else(|| Err(format!("Chat channel not handled: {channel}")))
    }

    fn unsupported_action(tool_name: &str, action: &str) -> Result<Value, String> {
        Err(format!("unsupported {tool_name} action: {action}"))
    }

    fn execute_redbox_skill(&self, arguments: &Value) -> Result<Value, String> {
        let action = payload_string(arguments, "action").unwrap_or_default();
        match action.as_str() {
            "list" => self.call_skill_channel("skills:list", json!({})),
            "invoke" => self.call_skill_channel(
                "skills:invoke",
                json!({
                    "name": payload_string(arguments, "name")
                        .or_else(|| payload_string(arguments, "skill"))
                        .unwrap_or_default(),
                    "sessionId": self.session_id,
                    "runtimeMode": self.runtime_mode,
                }),
            ),
            "create" => self.call_skill_channel(
                "skills:create",
                json!({ "name": payload_string(arguments, "name").unwrap_or_default() }),
            ),
            "save" => self.call_skill_channel(
                "skills:save",
                json!({
                    "location": payload_string(arguments, "location").unwrap_or_default(),
                    "content": payload_string(arguments, "content").unwrap_or_default(),
                }),
            ),
            "enable" => self.call_skill_channel(
                "skills:enable",
                json!({ "name": payload_string(arguments, "name").unwrap_or_default() }),
            ),
            "disable" => self.call_skill_channel(
                "skills:disable",
                json!({ "name": payload_string(arguments, "name").unwrap_or_default() }),
            ),
            "market_install" => self.call_skill_channel(
                "skills:market-install",
                json!({ "slug": payload_string(arguments, "slug").unwrap_or_default() }),
            ),
            "ai_roles_list" => self.call_skill_channel("ai:roles:list", json!({})),
            "detect_protocol" => self.call_skill_channel(
                "ai:detect-protocol",
                json!({
                    "baseURL": payload_string(arguments, "baseURL").unwrap_or_default(),
                    "presetId": payload_string(arguments, "presetId"),
                    "protocol": payload_string(arguments, "protocol"),
                }),
            ),
            "test_connection" => self.call_skill_channel(
                "ai:test-connection",
                json!({
                    "baseURL": payload_string(arguments, "baseURL").unwrap_or_default(),
                    "apiKey": payload_string(arguments, "apiKey"),
                    "presetId": payload_string(arguments, "presetId"),
                    "protocol": payload_string(arguments, "protocol"),
                }),
            ),
            "fetch_models" => self.call_skill_channel(
                "ai:fetch-models",
                json!({
                    "baseURL": payload_string(arguments, "baseURL").unwrap_or_default(),
                    "apiKey": payload_string(arguments, "apiKey"),
                    "presetId": payload_string(arguments, "presetId"),
                    "protocol": payload_string(arguments, "protocol"),
                }),
            ),
            _ => Self::unsupported_action("redbox_skill", &action),
        }
    }

    fn execute_app_cli(&self, arguments: &Value) -> Result<Value, String> {
        crate::tools::app_cli::AppCliExecutor::new(
            self.app,
            self.state,
            self.runtime_mode,
            self.session_id,
        )
        .execute(arguments)
    }

    fn execute_bash(&self, arguments: &Value) -> Result<Value, String> {
        crate::tools::bash::execute_bash(arguments, self.state)
    }

    fn execute_redbox_mcp(&self, arguments: &Value) -> Result<Value, String> {
        let action = payload_string(arguments, "action").unwrap_or_default();
        let server_value = || {
            payload_field(arguments, "server")
                .cloned()
                .unwrap_or_else(|| json!({}))
        };
        let parse_server = || -> Result<McpServerRecord, String> {
            serde_json::from_value(server_value()).map_err(|error| error.to_string())
        };
        match action.as_str() {
            "list" => commands::mcp_tools::mcp_list_value(self.state),
            "save" => commands::mcp_tools::handle_mcp_tools_channel(
                self.app,
                self.state,
                "mcp:save",
                &json!({ "servers": payload_field(arguments, "servers").cloned().unwrap_or_else(|| json!([])) }),
            )
            .unwrap_or_else(|| Err("MCP channel not handled: mcp:save".to_string())),
            "test" => commands::mcp_tools::mcp_probe_value(self.state, &parse_server()?),
            "call" => commands::mcp_tools::mcp_call_value(
                self.state,
                &parse_server()?,
                &payload_string(arguments, "method").unwrap_or_default(),
                payload_field(arguments, "params")
                    .cloned()
                    .unwrap_or_else(|| json!({})),
                payload_string(arguments, "sessionId"),
            ),
            "list_tools" => commands::mcp_tools::mcp_call_value(
                self.state,
                &parse_server()?,
                "tools/list",
                json!({}),
                payload_string(arguments, "sessionId"),
            ),
            "list_resources" => commands::mcp_tools::mcp_call_value(
                self.state,
                &parse_server()?,
                "resources/list",
                json!({}),
                payload_string(arguments, "sessionId"),
            ),
            "list_resource_templates" => commands::mcp_tools::mcp_call_value(
                self.state,
                &parse_server()?,
                "resources/templates/list",
                json!({}),
                payload_string(arguments, "sessionId"),
            ),
            "sessions" => commands::mcp_tools::mcp_sessions_value(self.state),
            "disconnect" => {
                commands::mcp_tools::mcp_disconnect_value(self.state, &parse_server()?)
            }
            "disconnect_all" => commands::mcp_tools::mcp_disconnect_all_value(self.state),
            "discover_local" => commands::mcp_tools::mcp_discover_local_value(),
            "import_local" => commands::mcp_tools::mcp_import_local_value(self.state),
            "oauth_status" => commands::mcp_tools::mcp_oauth_status_value(
                self.state,
                &payload_string(arguments, "serverId").unwrap_or_default(),
            ),
            _ => Self::unsupported_action("redbox_mcp", &action),
        }
    }

    fn execute_redbox_runtime_control(&self, arguments: &Value) -> Result<Value, String> {
        let action = payload_string(arguments, "action").unwrap_or_default();
        match action.as_str() {
            "runtime_query" => self.call_runtime_channel(
                "runtime:query",
                json!({
                    "sessionId": payload_string(arguments, "sessionId"),
                    "message": payload_string(arguments, "message").unwrap_or_default(),
                    "modelConfig": payload_field(arguments, "modelConfig").cloned().unwrap_or(Value::Null),
                }),
            ),
            "runtime_resume" => self.call_runtime_channel(
                "runtime:resume",
                json!({ "sessionId": payload_string(arguments, "sessionId").unwrap_or_default() }),
            ),
            "runtime_fork_session" => self.call_runtime_channel(
                "runtime:fork-session",
                json!({ "sessionId": payload_string(arguments, "sessionId").unwrap_or_default() }),
            ),
            "runtime_get_trace" => self.call_runtime_channel(
                "runtime:get-trace",
                json!({
                    "sessionId": payload_string(arguments, "sessionId").unwrap_or_default(),
                    "limit": payload_field(arguments, "limit").cloned().unwrap_or_else(|| json!(50)),
                }),
            ),
            "runtime_get_checkpoints" => self.call_runtime_channel(
                "runtime:get-checkpoints",
                json!({
                    "sessionId": payload_string(arguments, "sessionId").unwrap_or_default(),
                    "limit": payload_field(arguments, "limit").cloned().unwrap_or_else(|| json!(50)),
                }),
            ),
            "runtime_get_tool_results" => self.call_runtime_channel(
                "runtime:get-tool-results",
                json!({
                    "sessionId": payload_string(arguments, "sessionId").unwrap_or_default(),
                    "limit": payload_field(arguments, "limit").cloned().unwrap_or_else(|| json!(50)),
                }),
            ),
            "tasks_create" => self.call_runtime_channel(
                "tasks:create",
                payload_field(arguments, "payload")
                    .cloned()
                    .unwrap_or_else(|| json!({})),
            ),
            "tasks_list" => self.call_runtime_channel(
                "tasks:list",
                payload_field(arguments, "payload")
                    .cloned()
                    .unwrap_or_else(|| json!({})),
            ),
            "tasks_get" => self.call_runtime_channel(
                "tasks:get",
                json!({ "taskId": payload_string(arguments, "taskId").unwrap_or_default() }),
            ),
            "tasks_resume" => self.call_runtime_channel(
                "tasks:resume",
                json!({ "taskId": payload_string(arguments, "taskId").unwrap_or_default() }),
            ),
            "tasks_cancel" => self.call_runtime_channel(
                "tasks:cancel",
                json!({ "taskId": payload_string(arguments, "taskId").unwrap_or_default() }),
            ),
            "background_tasks_list" => self.call_bridge_channel("background-tasks:list", json!({})),
            "background_tasks_get" => self.call_bridge_channel(
                "background-tasks:get",
                json!({ "taskId": payload_string(arguments, "taskId").unwrap_or_default() }),
            ),
            "background_tasks_cancel" => self.call_bridge_channel(
                "background-tasks:cancel",
                json!({ "taskId": payload_string(arguments, "taskId").unwrap_or_default() }),
            ),
            "session_enter_diagnostics" => self.call_chat_channel(
                "chat:create-diagnostics-session",
                json!({
                    "title": payload_string(arguments, "title"),
                    "contextId": payload_string(arguments, "contextId"),
                    "contextType": payload_string(arguments, "contextType"),
                }),
            ),
            "session_bridge_status" => self.call_bridge_channel("session-bridge:status", json!({})),
            "session_bridge_list_sessions" => {
                self.call_bridge_channel("session-bridge:list-sessions", json!({}))
            }
            "session_bridge_get_session" => self.call_bridge_channel(
                "session-bridge:get-session",
                json!({ "sessionId": payload_string(arguments, "sessionId").unwrap_or_default() }),
            ),
            _ => Self::unsupported_action("redbox_runtime_control", &action),
        }
    }
}
