use serde_json::Value;
use std::collections::HashMap;

use crate::{
    normalize_string, payload_field, payload_string, slug_from_relative_path, McpServerRecord,
};

pub(super) fn mcp_target_name(payload: &Value) -> Result<String, String> {
    payload_string(payload, "serverId")
        .or_else(|| payload_string(payload, "id"))
        .or_else(|| payload_string(payload, "name"))
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "缺少 serverId 或 name".to_string())
}

pub(super) fn validate_mcp_server_name(name: &str) -> Result<(), String> {
    if name.trim().is_empty() {
        return Err("MCP server name cannot be empty".to_string());
    }
    if name
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
    {
        Ok(())
    } else {
        Err("MCP server name may only contain ASCII letters, numbers, '-' and '_'".to_string())
    }
}

pub(super) fn mcp_server_from_add_payload(
    payload: &Value,
    name: &str,
    existing: Option<&McpServerRecord>,
) -> Result<McpServerRecord, String> {
    let url = payload_string(payload, "url").filter(|value| !value.trim().is_empty());
    let command = payload_string(payload, "command").filter(|value| !value.trim().is_empty());
    if url.is_some() && command.is_some() {
        return Err("mcp add accepts either url or command, not both".to_string());
    }
    if url.is_none() && command.is_none() {
        return Err("mcp add requires either url or command".to_string());
    }
    let id = existing
        .map(|server| server.id.clone())
        .or_else(|| payload_string(payload, "serverId"))
        .or_else(|| payload_string(payload, "id"))
        .unwrap_or_else(|| format!("mcp-{}", slug_from_relative_path(name)));
    let enabled = payload_field(payload, "enabled")
        .and_then(Value::as_bool)
        .or_else(|| existing.map(|server| server.enabled))
        .unwrap_or(true);
    let transport = if url.is_some() {
        payload_string(payload, "transport").unwrap_or_else(|| "streamable-http".to_string())
    } else {
        payload_string(payload, "transport").unwrap_or_else(|| "stdio".to_string())
    };
    if url.is_some() && !matches!(transport.as_str(), "streamable-http" | "sse") {
        return Err("url MCP servers must use streamable-http or sse transport".to_string());
    }
    if command.is_some() && transport != "stdio" {
        return Err("command MCP servers must use stdio transport".to_string());
    }

    Ok(McpServerRecord {
        id,
        name: name.to_string(),
        enabled,
        transport,
        command,
        args: payload_string_array(payload, "args")
            .or_else(|| existing.and_then(|server| server.args.clone())),
        env: payload_string_map(payload, "env")
            .or_else(|| existing.and_then(|server| server.env.clone())),
        cwd: payload_string(payload, "cwd")
            .or_else(|| existing.and_then(|server| server.cwd.clone())),
        url,
        oauth: mcp_oauth_from_add_payload(payload)
            .or_else(|| existing.and_then(|server| server.oauth.clone())),
    })
}

fn payload_string_array(payload: &Value, key: &str) -> Option<Vec<String>> {
    payload_field(payload, key).and_then(|value| {
        value.as_array().map(|items| {
            items
                .iter()
                .filter_map(|item| normalize_string(Some(item)))
                .collect::<Vec<_>>()
        })
    })
}

fn payload_string_map(payload: &Value, key: &str) -> Option<HashMap<String, String>> {
    payload_field(payload, key).and_then(|value| {
        value.as_object().map(|object| {
            object
                .iter()
                .filter_map(|(key, value)| {
                    normalize_string(Some(value)).map(|text| (key.clone(), text))
                })
                .collect::<HashMap<_, _>>()
        })
    })
}

fn mcp_oauth_from_add_payload(payload: &Value) -> Option<Value> {
    let mut object = payload_field(payload, "oauth")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let mut redbox = object
        .get("redbox")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    for key in [
        "bearerTokenEnvVar",
        "required",
        "startupTimeoutMs",
        "toolTimeoutMs",
        "approvalMode",
        "defaultToolsApprovalMode",
        "supportsParallelToolCalls",
        "elicitationPausesTimeout",
        "enabledTools",
        "disabledTools",
    ] {
        if let Some(value) = payload_field(payload, key).cloned() {
            redbox.insert(key.to_string(), value);
        }
    }
    if !redbox.is_empty() {
        object.insert("redbox".to_string(), Value::Object(redbox));
    }
    if object.is_empty() {
        None
    } else {
        Some(Value::Object(object))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn validates_codex_style_mcp_names() {
        assert!(validate_mcp_server_name("github_mcp-1").is_ok());
        assert!(validate_mcp_server_name("github mcp").is_err());
        assert!(validate_mcp_server_name("").is_err());
    }

    #[test]
    fn builds_stdio_mcp_server_from_add_payload() {
        let server = mcp_server_from_add_payload(
            &json!({
                "name": "local_fs",
                "command": "npx",
                "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
                "env": { "DEBUG": "1" },
                "cwd": "/tmp"
            }),
            "local_fs",
            None,
        )
        .expect("stdio server should build");

        assert_eq!(server.id, "mcp-local_fs");
        assert_eq!(server.name, "local_fs");
        assert_eq!(server.transport, "stdio");
        assert_eq!(server.command.as_deref(), Some("npx"));
        assert_eq!(server.args.unwrap().len(), 3);
        assert_eq!(
            server.env.unwrap().get("DEBUG").map(String::as_str),
            Some("1")
        );
        assert_eq!(server.cwd.as_deref(), Some("/tmp"));
    }

    #[test]
    fn builds_http_mcp_server_from_add_payload() {
        let server = mcp_server_from_add_payload(
            &json!({
                "name": "remote_mcp",
                "url": "https://example.com/mcp",
                "bearerTokenEnvVar": "MCP_TOKEN"
            }),
            "remote_mcp",
            None,
        )
        .expect("http server should build");

        assert_eq!(server.transport, "streamable-http");
        assert_eq!(server.url.as_deref(), Some("https://example.com/mcp"));
        assert_eq!(
            server
                .oauth
                .as_ref()
                .and_then(|value| value.pointer("/redbox/bearerTokenEnvVar"))
                .and_then(Value::as_str),
            Some("MCP_TOKEN")
        );
    }
}
