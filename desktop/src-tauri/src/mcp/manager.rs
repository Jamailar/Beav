use crate::McpServerRecord;
use serde::Serialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use super::resources::McpCapabilitySnapshot;
use super::session::{McpSession, McpSessionSnapshot};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpInvocationResult {
    pub response: Value,
    pub session: McpSessionSnapshot,
    pub capabilities: McpCapabilitySnapshot,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpProbeResult {
    pub message: String,
    pub detail: String,
    pub session: McpSessionSnapshot,
    pub capabilities: McpCapabilitySnapshot,
}

#[derive(Default)]
pub struct McpManager {
    sessions: Mutex<HashMap<String, Arc<Mutex<McpSession>>>>,
}

impl McpManager {
    pub fn list_tools(&self, server: &McpServerRecord) -> Result<McpInvocationResult, String> {
        self.invoke(server, "tools/list", Value::Object(Default::default()))
    }

    pub fn list_resources(&self, server: &McpServerRecord) -> Result<McpInvocationResult, String> {
        self.invoke(server, "resources/list", Value::Object(Default::default()))
    }

    pub fn list_resource_templates(
        &self,
        server: &McpServerRecord,
    ) -> Result<McpInvocationResult, String> {
        self.invoke(
            server,
            "resources/templates/list",
            Value::Object(Default::default()),
        )
    }

    pub fn invoke(
        &self,
        server: &McpServerRecord,
        method: &str,
        params: Value,
    ) -> Result<McpInvocationResult, String> {
        let handle = self.session_handle(server)?;
        let mut session = handle.lock().map_err(|error| error.to_string())?;
        let response = session.invoke(method, params)?;
        Ok(McpInvocationResult {
            response,
            session: session.snapshot(),
            capabilities: session.capabilities(),
        })
    }

    pub fn probe(&self, server: &McpServerRecord) -> Result<McpProbeResult, String> {
        let handle = self.session_handle(server)?;
        let session = handle.lock().map_err(|error| error.to_string())?;
        let capabilities = session.capabilities();
        Ok(McpProbeResult {
            message: "连接成功".to_string(),
            detail: capabilities.detail_text(&server.name),
            session: session.snapshot(),
            capabilities,
        })
    }

    pub fn sessions(&self) -> Result<Vec<McpSessionSnapshot>, String> {
        let handles = self
            .sessions
            .lock()
            .map_err(|error| error.to_string())?
            .values()
            .cloned()
            .collect::<Vec<_>>();
        let mut snapshots = Vec::with_capacity(handles.len());
        for handle in handles {
            let session = handle.lock().map_err(|error| error.to_string())?;
            snapshots.push(session.snapshot());
        }
        snapshots.sort_by(|left, right| {
            right
                .last_used_at
                .cmp(&left.last_used_at)
                .then_with(|| left.server_name.cmp(&right.server_name))
        });
        Ok(snapshots)
    }

    pub fn session_for_server(
        &self,
        server: &McpServerRecord,
    ) -> Result<Option<McpSessionSnapshot>, String> {
        let key = session_key(server);
        let handle = self
            .sessions
            .lock()
            .map_err(|error| error.to_string())?
            .get(&key)
            .cloned();
        match handle {
            Some(handle) => {
                let session = handle.lock().map_err(|error| error.to_string())?;
                Ok(Some(session.snapshot()))
            }
            None => Ok(None),
        }
    }

    pub fn sync_servers(&self, servers: &[McpServerRecord]) -> Result<(), String> {
        let active_keys = servers
            .iter()
            .filter(|server| server.enabled)
            .map(session_key)
            .collect::<HashSet<_>>();
        let mut sessions = self.sessions.lock().map_err(|error| error.to_string())?;
        sessions.retain(|key, _| active_keys.contains(key));
        Ok(())
    }

    pub fn disconnect_server(&self, server: &McpServerRecord) -> Result<bool, String> {
        let key = session_key(server);
        let removed = self
            .sessions
            .lock()
            .map_err(|error| error.to_string())?
            .remove(&key)
            .is_some();
        Ok(removed)
    }

    pub fn disconnect_all(&self) -> Result<usize, String> {
        let mut sessions = self.sessions.lock().map_err(|error| error.to_string())?;
        let count = sessions.len();
        sessions.clear();
        Ok(count)
    }

    fn session_handle(&self, server: &McpServerRecord) -> Result<Arc<Mutex<McpSession>>, String> {
        let key = session_key(server);
        if let Some(handle) = self
            .sessions
            .lock()
            .map_err(|error| error.to_string())?
            .get(&key)
            .cloned()
        {
            return Ok(handle);
        }

        let created = Arc::new(Mutex::new(McpSession::connect(
            key.clone(),
            server.clone(),
        )?));
        let identity_prefix = format!("{}::", server_identity(server));
        let mut sessions = self.sessions.lock().map_err(|error| error.to_string())?;
        sessions.retain(|existing_key, _| {
            !(existing_key.starts_with(&identity_prefix) && existing_key != &key)
        });
        Ok(sessions
            .entry(key)
            .or_insert_with(|| created.clone())
            .clone())
    }
}

fn session_key(server: &McpServerRecord) -> String {
    format!(
        "{}::{}",
        server_identity(server),
        server_fingerprint(server)
    )
}

fn server_identity(server: &McpServerRecord) -> String {
    let identity = if !server.id.trim().is_empty() {
        &server.id
    } else if !server.name.trim().is_empty() {
        &server.name
    } else {
        &server.transport
    };
    identity.replace(':', "_")
}

fn server_fingerprint(server: &McpServerRecord) -> String {
    serde_json::to_string(&serde_json::json!({
        "enabled": server.enabled,
        "transport": server.transport.clone(),
        "command": server.command.clone(),
        "args": server.args.clone(),
        "env": server.env.clone(),
        "url": server.url.clone(),
    }))
    .unwrap_or_else(|_| "unknown".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn manager_reuses_stdio_session_across_calls() {
        let script_path = write_test_server_script();
        let server = McpServerRecord {
            id: "server-1".to_string(),
            name: "Test Server".to_string(),
            enabled: true,
            transport: "stdio".to_string(),
            command: Some("python3".to_string()),
            args: Some(vec![script_path.display().to_string()]),
            env: None,
            url: None,
            oauth: None,
        };
        let manager = McpManager::default();

        let probe = manager.probe(&server).unwrap();
        assert_eq!(probe.session.connection_strategy, "persistent");
        assert_eq!(probe.session.tool_count, 2);
        assert_eq!(probe.session.resource_count, 1);
        assert_eq!(probe.session.resource_template_count, 1);

        let first = manager
            .invoke(&server, "ping", serde_json::json!({}))
            .unwrap();
        let second = manager
            .invoke(&server, "ping", serde_json::json!({}))
            .unwrap();
        let first_pid = first
            .response
            .pointer("/result/pid")
            .and_then(Value::as_i64)
            .unwrap();
        let second_pid = second
            .response
            .pointer("/result/pid")
            .and_then(Value::as_i64)
            .unwrap();

        assert_eq!(first_pid, second_pid);
        assert!(second.session.call_count > first.session.call_count);
        let sessions = manager.sessions().unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].server_id, "server-1");

        let _ = fs::remove_file(script_path);
    }

    #[test]
    fn sync_servers_drops_sessions_for_removed_servers() {
        let script_path = write_test_server_script();
        let server = McpServerRecord {
            id: "server-1".to_string(),
            name: "Test Server".to_string(),
            enabled: true,
            transport: "stdio".to_string(),
            command: Some("python3".to_string()),
            args: Some(vec![script_path.display().to_string()]),
            env: None,
            url: None,
            oauth: None,
        };
        let manager = McpManager::default();

        let _ = manager
            .invoke(&server, "ping", serde_json::json!({}))
            .unwrap();
        assert_eq!(manager.sessions().unwrap().len(), 1);

        manager.sync_servers(&[]).unwrap();
        assert!(manager.sessions().unwrap().is_empty());

        let _ = fs::remove_file(script_path);
    }

    #[test]
    fn disconnect_server_removes_matching_session() {
        let script_path = write_test_server_script();
        let server = McpServerRecord {
            id: "server-1".to_string(),
            name: "Test Server".to_string(),
            enabled: true,
            transport: "stdio".to_string(),
            command: Some("python3".to_string()),
            args: Some(vec![script_path.display().to_string()]),
            env: None,
            url: None,
            oauth: None,
        };
        let manager = McpManager::default();

        let _ = manager
            .invoke(&server, "ping", serde_json::json!({}))
            .unwrap();
        assert_eq!(manager.sessions().unwrap().len(), 1);
        assert!(manager.disconnect_server(&server).unwrap());
        assert!(manager.sessions().unwrap().is_empty());

        let _ = fs::remove_file(script_path);
    }

    fn write_test_server_script() -> PathBuf {
        let mut path = std::env::temp_dir();
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        path.push(format!("lexbox-mcp-test-{}.py", unique));
        fs::write(
            &path,
            r#"import json
import os
import sys

def write_message(payload):
    body = json.dumps(payload).encode("utf-8")
    sys.stdout.buffer.write(f"Content-Length: {len(body)}\r\n\r\n".encode("utf-8"))
    sys.stdout.buffer.write(body)
    sys.stdout.buffer.flush()

tool_calls = 0

while True:
    headers = {}
    while True:
        line = sys.stdin.buffer.readline()
        if not line:
            sys.exit(0)
        if line in (b"\r\n", b"\n"):
            break
        key, value = line.decode("utf-8").split(":", 1)
        headers[key.strip().lower()] = value.strip()
    length = int(headers.get("content-length", "0"))
    if length <= 0:
        continue
    message = json.loads(sys.stdin.buffer.read(length))
    method = message.get("method")
    if method == "initialize":
        write_message({
            "jsonrpc": "2.0",
            "id": message["id"],
            "result": {
                "protocolVersion": "2024-11-05",
                "serverInfo": {"name": "Fixture MCP", "version": "0.1.0"}
            }
        })
    elif method == "notifications/initialized":
        continue
    elif method == "tools/list":
        tool_calls += 1
        write_message({
            "jsonrpc": "2.0",
            "id": message["id"],
            "result": {
                "tools": [{"name": "echo"}, {"name": "ping"}]
            }
        })
    elif method == "resources/list":
        write_message({
            "jsonrpc": "2.0",
            "id": message["id"],
            "result": {
                "resources": [{"uri": "memo://fixture"}]
            }
        })
    elif method == "resources/templates/list":
        write_message({
            "jsonrpc": "2.0",
            "id": message["id"],
            "result": {
                "resourceTemplates": [{"uriTemplate": "memo://{id}"}]
            }
        })
    elif method == "ping":
        write_message({
            "jsonrpc": "2.0",
            "id": message["id"],
            "result": {
                "pid": os.getpid(),
                "toolCalls": tool_calls
            }
        })
    else:
        write_message({
            "jsonrpc": "2.0",
            "id": message["id"],
            "result": {"ok": True, "method": method}
        })
"#,
        )
        .unwrap();
        path
    }
}
