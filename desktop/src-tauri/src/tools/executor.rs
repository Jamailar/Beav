use serde_json::Value;
use tauri::{AppHandle, State};

use crate::AppState;

pub struct PreparedToolCall {
    pub name: &'static str,
    pub arguments: Value,
}

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
            _ => None,
        }
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
