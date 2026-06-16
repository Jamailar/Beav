use crate::{
    app_brand_display_name, run_curl_json, run_sse_mcp_method, slug_from_relative_path,
    McpServerRecord,
};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, ChildStdout, Stdio};

use crate::cli_runtime::{build_effective_environment, load_host_shell_snapshot};
use crate::process_utils::background_command;

use super::resources::McpCapabilitySnapshot;

pub fn discover_local_mcp_configs() -> Vec<(String, Vec<McpServerRecord>)> {
    let mut sources = Vec::new();
    let mut candidates = vec![PathBuf::from(".mcp.json"), PathBuf::from("mcp.json")];
    if let Some(home) = dirs::home_dir() {
        candidates.push(home.join(".codex").join("mcp.json"));
        candidates.push(
            home.join("Library")
                .join("Application Support")
                .join("Claude")
                .join("claude_desktop_config.json"),
        );
    }
    for path in candidates {
        if !path.exists() {
            continue;
        }
        let Ok(content) = fs::read_to_string(&path) else {
            continue;
        };
        let Ok(value) = serde_json::from_str::<Value>(&content) else {
            continue;
        };
        let servers = extract_mcp_servers_from_json(&value);
        if !servers.is_empty() {
            sources.push((path.display().to_string(), servers));
        }
    }
    sources
}

pub(super) enum ManagedMcpTransport {
    Stdio(StdioMcpTransport),
    Stateless(StatelessMcpTransport),
}

impl ManagedMcpTransport {
    pub fn connect(server: McpServerRecord) -> Result<Self, String> {
        match server.transport.as_str() {
            "stdio" => Ok(Self::Stdio(StdioMcpTransport::start(server)?)),
            "streamable-http" | "sse" => Ok(Self::Stateless(StatelessMcpTransport { server })),
            other => Err(format!("不支持的 transport: {}", other)),
        }
    }

    pub fn prefers_cached_capabilities(&self) -> bool {
        matches!(self, Self::Stateless(_))
    }

    pub fn load_capabilities(&mut self) -> Result<McpCapabilitySnapshot, String> {
        match self {
            Self::Stdio(transport) => transport.load_capabilities(),
            Self::Stateless(transport) => transport.load_capabilities(),
        }
    }

    pub fn call(&mut self, method: &str, params: Value) -> Result<Value, String> {
        match self {
            Self::Stdio(transport) => transport.call(method, params),
            Self::Stateless(transport) => transport.call(method, params),
        }
    }
}

pub(super) struct StdioMcpTransport {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    initialize_response: Option<Value>,
    next_request_id: u64,
}

impl StdioMcpTransport {
    fn start(server: McpServerRecord) -> Result<Self, String> {
        let command = server
            .command
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| "缺少 stdio command".to_string())?;
        let custom_env = mcp_server_env(&server);
        let host = load_host_shell_snapshot();
        let effective = build_effective_environment(&host, None, Some(&custom_env));
        let mut process = background_command(command);
        process.args(server.args.clone().unwrap_or_default());
        if let Some(cwd) = server
            .cwd
            .as_deref()
            .filter(|value| !value.trim().is_empty())
        {
            process.current_dir(cwd);
        }
        process.env_clear();
        process.envs(&effective.env);
        let mut child = process
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .map_err(|error| {
                format!(
                    "{}; effectiveEnvironment={}",
                    error,
                    effective.metadata_value()
                )
            })?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "stdio server stdin unavailable".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "stdio server stdout unavailable".to_string())?;
        Ok(Self {
            child,
            stdin,
            stdout: BufReader::new(stdout),
            initialize_response: None,
            next_request_id: 2,
        })
    }

    fn load_capabilities(&mut self) -> Result<McpCapabilitySnapshot, String> {
        let initialize_response = self.ensure_initialized()?;
        let mut snapshot =
            McpCapabilitySnapshot::from_initialize_response(initialize_response, "persistent");
        for method in ["tools/list", "resources/list", "resources/templates/list"] {
            if let Ok(response) = self.call_request(method, json!({})) {
                snapshot.apply_method_response(method, response);
            }
        }
        Ok(snapshot)
    }

    fn call(&mut self, method: &str, params: Value) -> Result<Value, String> {
        let _ = self.ensure_initialized()?;
        self.call_request(method, params)
    }

    fn ensure_initialized(&mut self) -> Result<Value, String> {
        if let Some(response) = self.initialize_response.clone() {
            return Ok(response);
        }
        let response = self.call_request("initialize", initialize_params())?;
        self.send_notification("notifications/initialized", json!({}))?;
        self.initialize_response = Some(response.clone());
        Ok(response)
    }

    fn call_request(&mut self, method: &str, params: Value) -> Result<Value, String> {
        let request = json!({
            "jsonrpc": "2.0",
            "id": self.next_request_id,
            "method": method,
            "params": params,
        });
        self.next_request_id += 1;
        write_stdio_message(&mut self.stdin, &request)?;
        read_stdio_mcp_message(&mut self.stdout)
    }

    fn send_notification(&mut self, method: &str, params: Value) -> Result<(), String> {
        let notification = json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        });
        write_stdio_message(&mut self.stdin, &notification)
    }
}

fn mcp_server_env(server: &McpServerRecord) -> BTreeMap<String, String> {
    server.env.clone().unwrap_or_default().into_iter().collect()
}

pub fn mcp_stdio_effective_environment_metadata(server: &McpServerRecord) -> Option<Value> {
    if server.transport != "stdio" {
        return None;
    }
    let host = load_host_shell_snapshot();
    let custom_env = mcp_server_env(server);
    let effective = build_effective_environment(&host, None, Some(&custom_env));
    Some(json!({
        "hostShell": host.metadata_value(),
        "effectiveEnvironment": effective.metadata_value(),
        "command": server.command.clone(),
        "args": server.args.clone(),
        "cwd": server.cwd.clone(),
    }))
}

impl Drop for StdioMcpTransport {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

pub(super) struct StatelessMcpTransport {
    server: McpServerRecord,
}

impl StatelessMcpTransport {
    fn load_capabilities(&self) -> Result<McpCapabilitySnapshot, String> {
        let initialize_response = self.call("initialize", initialize_params())?;
        let mut snapshot =
            McpCapabilitySnapshot::from_initialize_response(initialize_response, "stateless");
        for method in ["tools/list", "resources/list", "resources/templates/list"] {
            if let Ok(response) = self.call(method, json!({})) {
                snapshot.apply_method_response(method, response);
            }
        }
        Ok(snapshot)
    }

    fn call(&self, method: &str, params: Value) -> Result<Value, String> {
        match self.server.transport.as_str() {
            "streamable-http" => {
                let url = self
                    .server
                    .url
                    .as_deref()
                    .filter(|value| !value.trim().is_empty())
                    .ok_or_else(|| "缺少 MCP URL".to_string())?;
                let api_key = mcp_bearer_token_from_env(&self.server);
                let owned_headers = mcp_http_headers(&self.server);
                let headers = owned_headers
                    .iter()
                    .map(|(name, value)| (name.as_str(), value.clone()))
                    .collect::<Vec<_>>();
                run_curl_json(
                    "POST",
                    url,
                    api_key.as_deref(),
                    &headers,
                    Some(json!({
                        "jsonrpc": "2.0",
                        "id": 1,
                        "method": method,
                        "params": params,
                    })),
                )
            }
            "sse" => {
                let url = self
                    .server
                    .url
                    .as_deref()
                    .filter(|value| !value.trim().is_empty())
                    .ok_or_else(|| "缺少 MCP URL".to_string())?;
                let api_key = mcp_bearer_token_from_env(&self.server);
                run_sse_mcp_method(url, method, params, api_key.as_deref())
            }
            other => Err(format!("不支持的 transport: {}", other)),
        }
    }
}

fn mcp_http_headers(server: &McpServerRecord) -> Vec<(String, String)> {
    let Some(redbox) = server.oauth.as_ref().and_then(|value| value.get("redbox")) else {
        return Vec::new();
    };
    let mut headers = Vec::new();
    if let Some(object) = redbox.get("httpHeaders").and_then(Value::as_object) {
        for (name, value) in object {
            if let Some(value) = value
                .as_str()
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                headers.push((name.clone(), value.to_string()));
            }
        }
    }
    if let Some(object) = redbox.get("envHttpHeaders").and_then(Value::as_object) {
        for (name, env_var) in object {
            let Some(env_var) = env_var
                .as_str()
                .map(str::trim)
                .filter(|value| !value.is_empty())
            else {
                continue;
            };
            if let Ok(value) = std::env::var(env_var) {
                let value = value.trim();
                if !value.is_empty() {
                    headers.push((name.clone(), value.to_string()));
                }
            }
        }
    }
    headers
}

fn mcp_bearer_token_from_env(server: &McpServerRecord) -> Option<String> {
    let env_var = server
        .oauth
        .as_ref()
        .and_then(|value| value.pointer("/redbox/bearerTokenEnvVar"))
        .or_else(|| {
            server
                .oauth
                .as_ref()
                .and_then(|value| value.get("bearerTokenEnvVar"))
        })
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())?;
    std::env::var(env_var)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn initialize_params() -> Value {
    json!({
        "protocolVersion": "2024-11-05",
        "capabilities": {},
        "clientInfo": {
            "name": app_brand_display_name(),
            "version": "0.1.0"
        }
    })
}

fn write_stdio_message(stdin: &mut ChildStdin, payload: &Value) -> Result<(), String> {
    let body = serde_json::to_string(payload).map_err(|error| error.to_string())?;
    let wire = format!("Content-Length: {}\r\n\r\n{}", body.len(), body);
    stdin
        .write_all(wire.as_bytes())
        .map_err(|error| error.to_string())?;
    stdin.flush().map_err(|error| error.to_string())
}

fn extract_mcp_servers_from_json(value: &Value) -> Vec<McpServerRecord> {
    let object = value
        .get("mcpServers")
        .and_then(|item| item.as_object())
        .cloned()
        .unwrap_or_default();
    object
        .into_iter()
        .map(|(name, config)| McpServerRecord {
            id: format!("mcp-{}", slug_from_relative_path(&name)),
            name: name.clone(),
            enabled: config
                .get("enabled")
                .and_then(|value| value.as_bool())
                .unwrap_or(true),
            transport: if config.get("url").is_some() {
                "streamable-http".to_string()
            } else {
                "stdio".to_string()
            },
            command: config
                .get("command")
                .and_then(|value| value.as_str())
                .map(ToString::to_string),
            args: config.get("args").and_then(|value| {
                value.as_array().map(|items| {
                    items
                        .iter()
                        .filter_map(|item| item.as_str().map(ToString::to_string))
                        .collect::<Vec<_>>()
                })
            }),
            env: config.get("env").and_then(|value| {
                value.as_object().map(|items| {
                    items
                        .iter()
                        .filter_map(|(key, value)| {
                            value.as_str().map(|value| (key.clone(), value.to_string()))
                        })
                        .collect::<std::collections::HashMap<_, _>>()
                })
            }),
            cwd: config
                .get("cwd")
                .and_then(|value| value.as_str())
                .map(ToString::to_string),
            url: config
                .get("url")
                .and_then(|value| value.as_str())
                .map(ToString::to_string),
            oauth: config.get("oauth").cloned(),
        })
        .collect()
}

fn read_stdio_mcp_message(
    reader: &mut BufReader<std::process::ChildStdout>,
) -> Result<Value, String> {
    let mut content_length = 0usize;
    loop {
        let mut line = String::new();
        let bytes = reader
            .read_line(&mut line)
            .map_err(|error| error.to_string())?;
        if bytes == 0 {
            break;
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            break;
        }
        if let Some(value) = trimmed.strip_prefix("Content-Length:") {
            content_length = value
                .trim()
                .parse::<usize>()
                .map_err(|error| error.to_string())?;
        }
    }
    if content_length == 0 {
        return Err("MCP stdio server returned no framed response".to_string());
    }
    let mut body = vec![0_u8; content_length];
    reader
        .read_exact(&mut body)
        .map_err(|error| error.to_string())?;
    serde_json::from_slice(&body).map_err(|error| error.to_string())
}
