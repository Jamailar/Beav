use serde_json::{json, Value};
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::Stdio;

use crate::{run_curl_json, run_sse_mcp_method, slug_from_relative_path, McpServerRecord};

pub(crate) fn extract_mcp_servers_from_json(value: &Value) -> Vec<McpServerRecord> {
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
            url: config
                .get("url")
                .and_then(|value| value.as_str())
                .map(ToString::to_string),
            oauth: config.get("oauth").cloned(),
        })
        .collect()
}

pub(crate) fn discover_local_mcp_configs() -> Vec<(String, Vec<McpServerRecord>)> {
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

pub(crate) fn read_stdio_mcp_message(
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

pub(crate) fn run_stdio_mcp_initialize_and_tools(
    command: &str,
    args: &[String],
) -> Result<(Value, Option<Value>), String> {
    let mut child = std::process::Command::new(command)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .map_err(|error| error.to_string())?;

    let stdin = child
        .stdin
        .as_mut()
        .ok_or_else(|| "stdio server stdin unavailable".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "stdio server stdout unavailable".to_string())?;
    let mut reader = BufReader::new(stdout);

    let initialize_request = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {
                "name": "RedBox",
                "version": "0.1.0"
            }
        }
    });
    let payload = serde_json::to_string(&initialize_request).map_err(|error| error.to_string())?;
    let wire = format!("Content-Length: {}\r\n\r\n{}", payload.len(), payload);
    stdin
        .write_all(wire.as_bytes())
        .map_err(|error| error.to_string())?;
    stdin.flush().map_err(|error| error.to_string())?;

    let initialize_response = read_stdio_mcp_message(&mut reader)?;

    let initialized_notification = json!({
        "jsonrpc": "2.0",
        "method": "notifications/initialized",
        "params": {}
    });
    let initialized_payload =
        serde_json::to_string(&initialized_notification).map_err(|error| error.to_string())?;
    let initialized_wire = format!(
        "Content-Length: {}\r\n\r\n{}",
        initialized_payload.len(),
        initialized_payload
    );
    stdin
        .write_all(initialized_wire.as_bytes())
        .map_err(|error| error.to_string())?;
    stdin.flush().map_err(|error| error.to_string())?;

    let tools_request = json!({
        "jsonrpc": "2.0",
        "id": 2,
        "method": "tools/list",
        "params": {}
    });
    let tools_payload = serde_json::to_string(&tools_request).map_err(|error| error.to_string())?;
    let tools_wire = format!(
        "Content-Length: {}\r\n\r\n{}",
        tools_payload.len(),
        tools_payload
    );
    stdin
        .write_all(tools_wire.as_bytes())
        .map_err(|error| error.to_string())?;
    stdin.flush().map_err(|error| error.to_string())?;

    let tools_response = read_stdio_mcp_message(&mut reader).ok();
    let _ = child.kill();
    let _ = child.wait();
    Ok((initialize_response, tools_response))
}

pub(crate) fn run_stdio_mcp_method(
    command: &str,
    args: &[String],
    method: &str,
    params: Value,
) -> Result<Value, String> {
    let mut child = std::process::Command::new(command)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .map_err(|error| error.to_string())?;

    let stdin = child
        .stdin
        .as_mut()
        .ok_or_else(|| "stdio server stdin unavailable".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "stdio server stdout unavailable".to_string())?;
    let mut reader = BufReader::new(stdout);

    let initialize_request = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {
                "name": "RedBox",
                "version": "0.1.0"
            }
        }
    });
    let init_payload =
        serde_json::to_string(&initialize_request).map_err(|error| error.to_string())?;
    let init_wire = format!(
        "Content-Length: {}\r\n\r\n{}",
        init_payload.len(),
        init_payload
    );
    stdin
        .write_all(init_wire.as_bytes())
        .map_err(|error| error.to_string())?;
    stdin.flush().map_err(|error| error.to_string())?;
    let _ = read_stdio_mcp_message(&mut reader)?;

    let initialized_notification = json!({
        "jsonrpc": "2.0",
        "method": "notifications/initialized",
        "params": {}
    });
    let initialized_payload =
        serde_json::to_string(&initialized_notification).map_err(|error| error.to_string())?;
    let initialized_wire = format!(
        "Content-Length: {}\r\n\r\n{}",
        initialized_payload.len(),
        initialized_payload
    );
    stdin
        .write_all(initialized_wire.as_bytes())
        .map_err(|error| error.to_string())?;
    stdin.flush().map_err(|error| error.to_string())?;

    let request = json!({
        "jsonrpc": "2.0",
        "id": 2,
        "method": method,
        "params": params
    });
    let payload = serde_json::to_string(&request).map_err(|error| error.to_string())?;
    let wire = format!("Content-Length: {}\r\n\r\n{}", payload.len(), payload);
    stdin
        .write_all(wire.as_bytes())
        .map_err(|error| error.to_string())?;
    stdin.flush().map_err(|error| error.to_string())?;

    let response = read_stdio_mcp_message(&mut reader)?;
    let _ = child.kill();
    let _ = child.wait();
    Ok(response)
}

pub(crate) fn invoke_mcp_server(
    server: &McpServerRecord,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    match server.transport.as_str() {
        "stdio" => {
            let command = server
                .command
                .as_deref()
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| "缺少 stdio command".to_string())?;
            run_stdio_mcp_method(
                command,
                &server.args.clone().unwrap_or_default(),
                method,
                params,
            )
        }
        "streamable-http" => {
            let url = server
                .url
                .as_deref()
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| "缺少 MCP URL".to_string())?;
            run_curl_json(
                "POST",
                url,
                None,
                &[],
                Some(json!({
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": method,
                    "params": params
                })),
            )
        }
        "sse" => {
            let url = server
                .url
                .as_deref()
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| "缺少 MCP URL".to_string())?;
            run_sse_mcp_method(url, method, params)
        }
        other => Err(format!("不支持的 transport: {}", other)),
    }
}

pub(crate) fn test_mcp_server(server: &McpServerRecord) -> Result<(String, String), String> {
    match server.transport.as_str() {
        "stdio" => {
            let command = server
                .command
                .as_deref()
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| "缺少 stdio command".to_string())?;
            let (initialize_response, tools_response) = run_stdio_mcp_initialize_and_tools(
                command,
                &server.args.clone().unwrap_or_default(),
            )?;
            let server_name = initialize_response
                .pointer("/result/serverInfo/name")
                .and_then(|value| value.as_str())
                .unwrap_or(command);
            let protocol = initialize_response
                .pointer("/result/protocolVersion")
                .and_then(|value| value.as_str())
                .unwrap_or("unknown");
            let tool_count = tools_response
                .as_ref()
                .and_then(|value| value.pointer("/result/tools"))
                .and_then(|value| value.as_array())
                .map(|items| items.len())
                .unwrap_or(0);
            Ok((
                "连接成功".to_string(),
                format!(
                    "initialized {} ({}) · tools {}",
                    server_name, protocol, tool_count
                ),
            ))
        }
        "sse" | "streamable-http" => {
            let url = server
                .url
                .as_deref()
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| "缺少 MCP URL".to_string())?;
            if server.transport == "streamable-http" {
                let init_response = run_curl_json(
                    "POST",
                    url,
                    None,
                    &[],
                    Some(json!({
                        "jsonrpc": "2.0",
                        "id": 1,
                        "method": "initialize",
                        "params": {
                            "protocolVersion": "2024-11-05",
                            "capabilities": {},
                            "clientInfo": {
                                "name": "RedBox",
                                "version": "0.1.0"
                            }
                        }
                    })),
                )?;
                let server_name = init_response
                    .pointer("/result/serverInfo/name")
                    .and_then(|value| value.as_str())
                    .unwrap_or("unknown");
                let tools_response = run_curl_json(
                    "POST",
                    url,
                    None,
                    &[],
                    Some(json!({
                        "jsonrpc": "2.0",
                        "id": 2,
                        "method": "tools/list",
                        "params": {}
                    })),
                )?;
                let tool_count = tools_response
                    .pointer("/result/tools")
                    .and_then(|value| value.as_array())
                    .map(|items| items.len())
                    .unwrap_or(0);
                return Ok((
                    "连接成功".to_string(),
                    format!("initialized {} · tools {}", server_name, tool_count),
                ));
            }

            let init_response = run_sse_mcp_method(
                url,
                "initialize",
                json!({
                    "protocolVersion": "2024-11-05",
                    "capabilities": {},
                    "clientInfo": {
                        "name": "RedBox",
                        "version": "0.1.0"
                    }
                }),
            )?;
            let server_name = init_response
                .pointer("/result/serverInfo/name")
                .and_then(|value| value.as_str())
                .unwrap_or("unknown");
            let tools_response = run_sse_mcp_method(url, "tools/list", json!({}))?;
            let tool_count = tools_response
                .pointer("/result/tools")
                .and_then(|value| value.as_array())
                .map(|items| items.len())
                .unwrap_or(0);
            Ok((
                "连接成功".to_string(),
                format!("initialized {} · tools {}", server_name, tool_count),
            ))
        }
        other => Err(format!("不支持的 transport: {}", other)),
    }
}
