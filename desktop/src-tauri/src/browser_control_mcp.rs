use crate::{AppStore, McpServerRecord};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::time::Duration;

const SERVER_ID: &str = "builtin:redbox-browser-control";
const SERVER_NAME: &str = "RedBox Browser Control";
const MCP_ARG: &str = "--redbox-browser-control-mcp";
const DEFAULT_TIMEOUT_MS: u64 = 30_000;

const ENABLED_TOOLS: &[&str] = &[
    "browser.info",
    "browser.capabilities",
    "browser.context",
    "browser.events",
    "browser.events.summary",
    "browser.sessionEvents",
    "browser.visibility.get",
    "browser.visibility.set",
    "windows.list",
    "history.search",
    "tabs.list",
    "tabs.finalize",
    "session.name",
    "turn.ended",
    "tab.info",
    "tab.claim",
    "tab.create",
    "tab.navigate",
    "tab.back",
    "tab.forward",
    "tab.reload",
    "tab.close",
    "page.frames",
    "page.waitForLoadState",
    "page.waitForURL",
    "page.waitForTimeout",
    "page.evaluate",
    "page.domSnapshot",
    "page.waitForSelector",
    "page.queryElements",
    "page.click",
    "page.doubleClick",
    "page.hover",
    "node.click",
    "page.scroll",
    "node.scroll",
    "page.type",
    "page.check",
    "page.setChecked",
    "page.isChecked",
    "page.isVisible",
    "page.getValue",
    "page.getValues",
    "page.getAttribute",
    "page.select",
    "page.consoleLogs",
    "page.assets",
    "page.screenshot",
    "clipboard.read",
    "clipboard.readText",
    "clipboard.write",
    "clipboard.writeText",
    "input.mouseMove",
    "input.mouseClick",
    "input.mouseDrag",
    "input.mouseWheel",
    "input.keyboardType",
    "input.keyboardPress",
    "input.keyboardCombo",
    "viewport.state",
    "viewport.set",
    "viewport.reset",
    "cdp.send",
];

const READ_ONLY_TOOLS: &[&str] = &[
    "browser.info",
    "browser.capabilities",
    "browser.events",
    "browser.events.summary",
    "browser.sessionEvents",
    "browser.visibility.get",
    "windows.list",
    "tabs.list",
    "tab.info",
    "page.frames",
    "page.waitForLoadState",
    "page.waitForURL",
    "page.waitForTimeout",
    "page.domSnapshot",
    "page.waitForSelector",
    "page.queryElements",
    "page.isChecked",
    "page.isVisible",
    "page.getValue",
    "page.getValues",
    "page.getAttribute",
    "page.assets",
    "page.screenshot",
    "page.consoleLogs",
    "viewport.state",
];

pub(crate) fn maybe_run_from_args() -> bool {
    if !std::env::args().any(|arg| arg == MCP_ARG) {
        return false;
    }
    if let Err(error) = run_stdio_server() {
        let _ = writeln!(
            std::io::stderr(),
            "redbox browser-control MCP failed: {error}"
        );
        std::process::exit(1);
    }
    true
}

pub(crate) fn ensure_builtin_browser_control_mcp(store: &mut AppStore) -> bool {
    let next = builtin_server_record(true);
    match store
        .mcp_servers
        .iter_mut()
        .find(|server| server.id == SERVER_ID)
    {
        Some(existing) => {
            let enabled = existing.enabled;
            let mut updated = next;
            updated.enabled = enabled;
            if same_server_record(existing, &updated) {
                return false;
            }
            *existing = updated;
            true
        }
        None => {
            store.mcp_servers.push(next);
            true
        }
    }
}

fn builtin_server_record(enabled: bool) -> McpServerRecord {
    let command = std::env::current_exe()
        .ok()
        .map(display_path)
        .or_else(|| std::env::args().next())
        .unwrap_or_else(|| "redbox".to_string());
    McpServerRecord {
        id: SERVER_ID.to_string(),
        name: SERVER_NAME.to_string(),
        enabled,
        transport: "stdio".to_string(),
        command: Some(command),
        args: Some(vec![MCP_ARG.to_string()]),
        env: Some(HashMap::from([(
            "REDBOX_BROWSER_CONTROL_MCP_MODE".to_string(),
            "builtin".to_string(),
        )])),
        cwd: None,
        url: None,
        oauth: Some(policy_metadata()),
    }
}

fn policy_metadata() -> Value {
    let per_tool = READ_ONLY_TOOLS
        .iter()
        .map(|name| {
            (
                name.to_string(),
                json!({
                    "approvalMode": "never"
                }),
            )
        })
        .collect::<serde_json::Map<_, _>>();
    json!({
        "redbox": {
            "builtinBrowserControl": true,
            "required": false,
            "approvalMode": "destructive",
            "startupTimeoutMs": 15_000,
            "toolTimeoutMs": 60_000,
            "supportsParallelToolCalls": false,
            "enabledTools": ENABLED_TOOLS,
            "perTool": per_tool
        }
    })
}

fn same_server_record(left: &McpServerRecord, right: &McpServerRecord) -> bool {
    serde_json::to_value(left).ok() == serde_json::to_value(right).ok()
}

fn display_path(path: PathBuf) -> String {
    path.display().to_string()
}

fn run_stdio_server() -> Result<(), String> {
    let mut input = Vec::<u8>::new();
    let mut buffer = [0u8; 8192];
    loop {
        let read = std::io::stdin()
            .read(&mut buffer)
            .map_err(|error| error.to_string())?;
        if read == 0 {
            return Ok(());
        }
        input.extend_from_slice(&buffer[..read]);
        while let Some(message) = take_stdio_message(&mut input)? {
            if let Some(response) = handle_mcp_message(message) {
                write_stdio_message(&response)?;
            }
        }
    }
}

fn take_stdio_message(input: &mut Vec<u8>) -> Result<Option<Value>, String> {
    let Some(header_end) = find_header_end(input) else {
        return Ok(None);
    };
    let headers = std::str::from_utf8(&input[..header_end]).map_err(|error| error.to_string())?;
    let length = content_length(headers).ok_or_else(|| "missing Content-Length".to_string())?;
    let body_start = header_end + 4;
    let body_end = body_start + length;
    if input.len() < body_end {
        return Ok(None);
    }
    let body = input[body_start..body_end].to_vec();
    input.drain(..body_end);
    serde_json::from_slice::<Value>(&body)
        .map(Some)
        .map_err(|error| error.to_string())
}

fn find_header_end(input: &[u8]) -> Option<usize> {
    input.windows(4).position(|window| window == b"\r\n\r\n")
}

fn content_length(headers: &str) -> Option<usize> {
    headers.lines().find_map(|line| {
        let (name, value) = line.split_once(':')?;
        name.trim()
            .eq_ignore_ascii_case("content-length")
            .then(|| value.trim().parse::<usize>().ok())
            .flatten()
    })
}

fn handle_mcp_message(message: Value) -> Option<Value> {
    let id = message.get("id").cloned().unwrap_or(Value::Null);
    let method = message.get("method").and_then(Value::as_str)?;
    let response = match method {
        "initialize" => Ok(json!({
            "protocolVersion": message
                .pointer("/params/protocolVersion")
                .and_then(Value::as_str)
                .unwrap_or("2024-11-05"),
            "capabilities": { "tools": {} },
            "serverInfo": { "name": "redbox-browser-control", "version": "0.1.0" }
        })),
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({ "tools": list_tools() })),
        "tools/call" => handle_tools_call(&message),
        "notifications/initialized" => return None,
        other => Err(json_rpc_error(
            -32601,
            format!("Unsupported MCP method: {other}"),
        )),
    };
    Some(match response {
        Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
        Err(error) => json!({ "jsonrpc": "2.0", "id": id, "error": error }),
    })
}

fn handle_tools_call(message: &Value) -> Result<Value, Value> {
    let name = message
        .pointer("/params/name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| json_rpc_error(-32602, "tools/call requires params.name"))?;
    let arguments = message
        .pointer("/params/arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let request = json!({
        "jsonrpc": "2.0",
        "id": format!("mcp:{}", crate::now_i64()),
        "method": "tools/call",
        "params": {
            "name": name,
            "arguments": arguments
        }
    });
    match call_agent_socket(request, DEFAULT_TIMEOUT_MS) {
        Ok(response) => Ok(json!({
            "content": [{ "type": "text", "text": serde_json::to_string_pretty(&response).unwrap_or_else(|_| "{}".to_string()) }],
            "isError": response.get("error").is_some()
        })),
        Err(error) => Err(json_rpc_error(-32000, error)),
    }
}

fn list_tools() -> Vec<Value> {
    let request = json!({
        "jsonrpc": "2.0",
        "id": format!("mcp-tools:{}", crate::now_i64()),
        "method": "tools/list",
        "params": {}
    });
    call_agent_socket(request, DEFAULT_TIMEOUT_MS)
        .ok()
        .and_then(|response| {
            response
                .pointer("/result/tools")
                .or_else(|| response.get("tools"))
                .and_then(Value::as_array)
                .cloned()
        })
        .filter(|tools| !tools.is_empty())
        .unwrap_or_else(fallback_tools)
}

fn fallback_tools() -> Vec<Value> {
    vec![
        browser_tool(
            "browser.capabilities",
            "Return browser-control capabilities and action contracts.",
            json!({}),
            vec![],
        ),
        browser_tool(
            "browser.info",
            "Return browser-control backend, session, policy, and capability metadata.",
            json!({}),
            vec![],
        ),
        browser_tool(
            "browser.context",
            "Return readonly user browser context such as open tabs, windows, and history summaries.",
            json!({ "limit": { "type": "number" } }),
            vec![],
        ),
        browser_tool(
            "browser.events",
            "Replay browser-control runtime events.",
            json!({ "limit": { "type": "number" }, "afterEventId": { "type": "string" } }),
            vec![],
        ),
        browser_tool(
            "browser.events.summary",
            "Summarize browser-control runtime events.",
            json!({}),
            vec![],
        ),
        browser_tool(
            "browser.sessionEvents",
            "Replay browser-control session lifecycle events.",
            json!({ "sessionId": { "type": "string" }, "limit": { "type": "number" } }),
            vec![],
        ),
        browser_tool(
            "browser.visibility.get",
            "Return browser window visibility state.",
            json!({ "windowId": { "type": "number" } }),
            vec![],
        ),
        browser_tool(
            "browser.visibility.set",
            "Set browser window visibility state.",
            json!({ "windowId": { "type": "number" }, "state": { "type": "string" } }),
            vec![],
        ),
        browser_tool(
            "windows.list",
            "List browser windows with bounded metadata.",
            json!({ "limit": { "type": "number" } }),
            vec![],
        ),
        browser_tool(
            "history.search",
            "Search recent browser history metadata.",
            json!({ "query": { "type": "string" }, "limit": { "type": "number" } }),
            vec![],
        ),
        browser_tool(
            "tabs.list",
            "List current user browser tabs.",
            json!({ "limit": { "type": "number" } }),
            vec![],
        ),
        browser_tool(
            "tab.info",
            "Read metadata for a tab or the current active tab.",
            json!({ "tabId": { "type": "number" }, "activeOnly": { "type": "boolean" }, "sessionId": { "type": "string" } }),
            vec![],
        ),
        browser_tool(
            "tabs.finalize",
            "Finalize browser-control tabs, closing or handing off tabs according to keep entries.",
            json!({ "keep": { "type": "array", "items": { "type": "object" } }, "sessionId": { "type": "string" } }),
            vec![],
        ),
        browser_tool(
            "session.name",
            "Name the current browser-control session.",
            json!({ "name": { "type": "string" }, "sessionId": { "type": "string" } }),
            vec!["name"],
        ),
        browser_tool(
            "turn.ended",
            "Mark the current browser-control turn ended.",
            json!({ "turnId": { "type": "string" }, "sessionId": { "type": "string" } }),
            vec![],
        ),
        browser_tool(
            "tab.claim",
            "Claim an existing user tab for an AI browser-control session.",
            json!({ "tabId": { "type": "number" }, "sessionId": { "type": "string" } }),
            vec!["tabId"],
        ),
        browser_tool(
            "tab.create",
            "Create a controlled browser tab.",
            json!({ "url": { "type": "string" }, "active": { "type": "boolean" }, "sessionId": { "type": "string" } }),
            vec![],
        ),
        browser_tool(
            "tab.navigate",
            "Navigate an existing tab to an http or https URL.",
            json!({ "tabId": { "type": "number" }, "url": { "type": "string" }, "sessionId": { "type": "string" } }),
            vec!["tabId", "url"],
        ),
        browser_tool(
            "tab.back",
            "Navigate a controlled tab back in history.",
            json!({ "tabId": { "type": "number" }, "waitUntil": { "type": "string" }, "timeoutMs": { "type": "number" }, "sessionId": { "type": "string" } }),
            vec!["tabId"],
        ),
        browser_tool(
            "tab.forward",
            "Navigate a controlled tab forward in history.",
            json!({ "tabId": { "type": "number" }, "waitUntil": { "type": "string" }, "timeoutMs": { "type": "number" }, "sessionId": { "type": "string" } }),
            vec!["tabId"],
        ),
        browser_tool(
            "tab.reload",
            "Reload a controlled tab.",
            json!({ "tabId": { "type": "number" }, "sessionId": { "type": "string" } }),
            vec!["tabId"],
        ),
        browser_tool(
            "tab.close",
            "Close a controlled tab.",
            json!({ "tabId": { "type": "number" }, "sessionId": { "type": "string" } }),
            vec!["tabId"],
        ),
        browser_tool(
            "page.frames",
            "List frames in a controlled tab.",
            json!({ "tabId": { "type": "number" }, "sessionId": { "type": "string" } }),
            vec!["tabId"],
        ),
        browser_tool(
            "page.waitForLoadState",
            "Wait for a controlled tab to reach a load state.",
            json!({ "tabId": { "type": "number" }, "state": { "type": "string" }, "timeoutMs": { "type": "number" }, "sessionId": { "type": "string" } }),
            vec!["tabId"],
        ),
        browser_tool(
            "page.waitForURL",
            "Wait for a controlled tab URL to match a target, wildcard, or regex.",
            json!({ "tabId": { "type": "number" }, "url": { "type": "string" }, "urlRegex": { "type": "string" }, "exact": { "type": "boolean" }, "timeoutMs": { "type": "number" }, "sessionId": { "type": "string" } }),
            vec!["tabId"],
        ),
        browser_tool(
            "page.waitForTimeout",
            "Wait for a fixed duration in a controlled tab context.",
            json!({ "tabId": { "type": "number" }, "timeoutMs": { "type": "number" }, "ms": { "type": "number" }, "sessionId": { "type": "string" } }),
            vec!["tabId"],
        ),
        browser_tool(
            "page.evaluate",
            "Evaluate JavaScript in a controlled tab through CDP; browser policy treats this as state-changing unless approved.",
            json!({ "tabId": { "type": "number" }, "script": { "type": "string" }, "expression": { "type": "string" }, "timeoutMs": { "type": "number" }, "sessionId": { "type": "string" } }),
            vec!["tabId"],
        ),
        browser_tool(
            "page.domSnapshot",
            "Read a bounded DOM snapshot for a tab or frame.",
            json!({ "tabId": { "type": "number" }, "frameId": { "type": "number" }, "sessionId": { "type": "string" } }),
            vec!["tabId"],
        ),
        browser_tool(
            "page.waitForSelector",
            "Wait for a selector to appear in a controlled tab.",
            json!({ "tabId": { "type": "number" }, "selector": { "type": "string" }, "timeoutMs": { "type": "number" }, "sessionId": { "type": "string" } }),
            vec!["tabId", "selector"],
        ),
        browser_tool(
            "page.queryElements",
            "Query visible page elements by selector.",
            json!({ "tabId": { "type": "number" }, "selector": { "type": "string" }, "limit": { "type": "number" }, "sessionId": { "type": "string" } }),
            vec!["tabId", "selector"],
        ),
        browser_tool(
            "page.click",
            "Click a page element by selector, text, or node reference.",
            json!({ "tabId": { "type": "number" }, "selector": { "type": "string" }, "text": { "type": "string" }, "sessionId": { "type": "string" } }),
            vec!["tabId"],
        ),
        browser_tool(
            "page.doubleClick",
            "Double-click a page element by selector or text.",
            json!({ "tabId": { "type": "number" }, "selector": { "type": "string" }, "text": { "type": "string" }, "sessionId": { "type": "string" } }),
            vec!["tabId"],
        ),
        browser_tool(
            "page.hover",
            "Hover a page element by selector or text.",
            json!({ "tabId": { "type": "number" }, "selector": { "type": "string" }, "text": { "type": "string" }, "sessionId": { "type": "string" } }),
            vec!["tabId"],
        ),
        browser_tool(
            "node.click",
            "Click a page node by DOM snapshot node reference.",
            json!({ "tabId": { "type": "number" }, "nodeId": { "type": "string" }, "sessionId": { "type": "string" } }),
            vec!["tabId"],
        ),
        browser_tool(
            "page.scroll",
            "Scroll a controlled tab or frame.",
            json!({ "tabId": { "type": "number" }, "direction": { "type": "string" }, "pixels": { "type": "number" }, "sessionId": { "type": "string" } }),
            vec!["tabId"],
        ),
        browser_tool(
            "node.scroll",
            "Scroll a DOM snapshot node.",
            json!({ "tabId": { "type": "number" }, "nodeId": { "type": "string" }, "deltaY": { "type": "number" }, "sessionId": { "type": "string" } }),
            vec!["tabId"],
        ),
        browser_tool(
            "page.type",
            "Type text into a page element.",
            json!({ "tabId": { "type": "number" }, "selector": { "type": "string" }, "text": { "type": "string" }, "sessionId": { "type": "string" } }),
            vec!["tabId", "selector", "text"],
        ),
        browser_tool(
            "page.check",
            "Check a checkbox or switch-like page element.",
            json!({ "tabId": { "type": "number" }, "selector": { "type": "string" }, "sessionId": { "type": "string" } }),
            vec!["tabId", "selector"],
        ),
        browser_tool(
            "page.setChecked",
            "Set a checkbox or switch-like page element state.",
            json!({ "tabId": { "type": "number" }, "selector": { "type": "string" }, "checked": { "type": "boolean" }, "sessionId": { "type": "string" } }),
            vec!["tabId", "selector"],
        ),
        browser_tool(
            "page.isChecked",
            "Return whether a checkbox or switch-like element is checked.",
            json!({ "tabId": { "type": "number" }, "selector": { "type": "string" }, "sessionId": { "type": "string" } }),
            vec!["tabId", "selector"],
        ),
        browser_tool(
            "page.isVisible",
            "Return whether a page element is visible.",
            json!({ "tabId": { "type": "number" }, "selector": { "type": "string" }, "sessionId": { "type": "string" } }),
            vec!["tabId", "selector"],
        ),
        browser_tool(
            "page.getValue",
            "Read the value of a page form element.",
            json!({ "tabId": { "type": "number" }, "selector": { "type": "string" }, "sessionId": { "type": "string" } }),
            vec!["tabId", "selector"],
        ),
        browser_tool(
            "page.getValues",
            "Read values from matching page form elements.",
            json!({ "tabId": { "type": "number" }, "selector": { "type": "string" }, "sessionId": { "type": "string" } }),
            vec!["tabId", "selector"],
        ),
        browser_tool(
            "page.getAttribute",
            "Read an attribute from a page element.",
            json!({ "tabId": { "type": "number" }, "selector": { "type": "string" }, "attribute": { "type": "string" }, "sessionId": { "type": "string" } }),
            vec!["tabId", "selector"],
        ),
        browser_tool(
            "page.select",
            "Select one or more options in a native select element.",
            json!({ "tabId": { "type": "number" }, "selector": { "type": "string" }, "value": { "type": "string" }, "sessionId": { "type": "string" } }),
            vec!["tabId", "selector"],
        ),
        browser_tool(
            "page.consoleLogs",
            "Read console logs captured for a controlled tab.",
            json!({ "tabId": { "type": "number" }, "limit": { "type": "number" }, "sessionId": { "type": "string" } }),
            vec!["tabId"],
        ),
        browser_tool(
            "page.assets",
            "List images, videos, documents, favicons, and linked assets found on a page.",
            json!({ "tabId": { "type": "number" }, "limit": { "type": "number" }, "sessionId": { "type": "string" } }),
            vec!["tabId"],
        ),
        browser_tool(
            "page.screenshot",
            "Capture a visible-tab screenshot as a data URL.",
            json!({ "tabId": { "type": "number" }, "format": { "type": "string" }, "quality": { "type": "number" }, "sessionId": { "type": "string" } }),
            vec!["tabId"],
        ),
        browser_tool(
            "clipboard.read",
            "Read browser clipboard items for a controlled tab.",
            json!({ "tabId": { "type": "number" }, "sessionId": { "type": "string" } }),
            vec!["tabId"],
        ),
        browser_tool(
            "clipboard.readText",
            "Read browser clipboard text for a controlled tab.",
            json!({ "tabId": { "type": "number" }, "sessionId": { "type": "string" } }),
            vec!["tabId"],
        ),
        browser_tool(
            "clipboard.write",
            "Write browser clipboard items for a controlled tab.",
            json!({ "tabId": { "type": "number" }, "items": { "type": "array" }, "sessionId": { "type": "string" } }),
            vec!["tabId"],
        ),
        browser_tool(
            "clipboard.writeText",
            "Write browser clipboard text for a controlled tab.",
            json!({ "tabId": { "type": "number" }, "text": { "type": "string" }, "sessionId": { "type": "string" } }),
            vec!["tabId", "text"],
        ),
        browser_tool(
            "input.mouseMove",
            "Move the browser mouse cursor overlay.",
            json!({ "tabId": { "type": "number" }, "x": { "type": "number" }, "y": { "type": "number" }, "sessionId": { "type": "string" } }),
            vec!["tabId", "x", "y"],
        ),
        browser_tool(
            "input.mouseClick",
            "Click browser viewport coordinates.",
            json!({ "tabId": { "type": "number" }, "x": { "type": "number" }, "y": { "type": "number" }, "button": { "type": "string" }, "sessionId": { "type": "string" } }),
            vec!["tabId", "x", "y"],
        ),
        browser_tool(
            "input.mouseDrag",
            "Drag between browser viewport coordinates.",
            json!({ "tabId": { "type": "number" }, "from": { "type": "object" }, "to": { "type": "object" }, "path": { "type": "array" }, "sessionId": { "type": "string" } }),
            vec!["tabId"],
        ),
        browser_tool(
            "input.mouseWheel",
            "Scroll by browser viewport wheel deltas.",
            json!({ "tabId": { "type": "number" }, "deltaX": { "type": "number" }, "deltaY": { "type": "number" }, "sessionId": { "type": "string" } }),
            vec!["tabId"],
        ),
        browser_tool(
            "input.keyboardType",
            "Type text through browser keyboard input.",
            json!({ "tabId": { "type": "number" }, "text": { "type": "string" }, "sessionId": { "type": "string" } }),
            vec!["tabId", "text"],
        ),
        browser_tool(
            "input.keyboardPress",
            "Press a browser keyboard key.",
            json!({ "tabId": { "type": "number" }, "key": { "type": "string" }, "sessionId": { "type": "string" } }),
            vec!["tabId", "key"],
        ),
        browser_tool(
            "input.keyboardCombo",
            "Press a browser keyboard shortcut.",
            json!({ "tabId": { "type": "number" }, "keys": { "type": "array", "items": { "type": "string" } }, "sessionId": { "type": "string" } }),
            vec!["tabId", "keys"],
        ),
        browser_tool(
            "viewport.state",
            "Read browser viewport state.",
            json!({ "windowId": { "type": "number" }, "sessionId": { "type": "string" } }),
            vec![],
        ),
        browser_tool(
            "viewport.set",
            "Set browser viewport dimensions.",
            json!({ "width": { "type": "number" }, "height": { "type": "number" }, "windowId": { "type": "number" }, "sessionId": { "type": "string" } }),
            vec!["width", "height"],
        ),
        browser_tool(
            "viewport.reset",
            "Reset browser viewport state.",
            json!({ "windowId": { "type": "number" }, "sessionId": { "type": "string" } }),
            vec![],
        ),
        browser_tool(
            "cdp.send",
            "Send a Chrome DevTools Protocol command to an attached tab.",
            json!({ "tabId": { "type": "number" }, "method": { "type": "string" }, "params": { "type": "object" }, "sessionId": { "type": "string" } }),
            vec!["tabId", "method"],
        ),
    ]
}

fn browser_tool(name: &str, description: &str, properties: Value, required: Vec<&str>) -> Value {
    json!({
        "name": name,
        "description": description,
        "inputSchema": {
            "type": "object",
            "properties": properties,
            "required": required,
            "additionalProperties": true
        }
    })
}

fn write_stdio_message(message: &Value) -> Result<(), String> {
    let body = serde_json::to_string(message).map_err(|error| error.to_string())?;
    let mut stdout = std::io::stdout();
    write!(stdout, "Content-Length: {}\r\n\r\n{}", body.len(), body)
        .map_err(|error| error.to_string())?;
    stdout.flush().map_err(|error| error.to_string())
}

fn json_rpc_error(code: i64, message: impl Into<String>) -> Value {
    json!({ "code": code, "message": message.into() })
}

#[cfg(unix)]
fn call_agent_socket(request: Value, timeout_ms: u64) -> Result<Value, String> {
    use std::os::unix::net::UnixStream;

    let socket_path = resolve_socket_path();
    let mut stream = UnixStream::connect(&socket_path).map_err(|error| {
        format!(
            "failed to connect browser-control socket {}: {error}",
            socket_path.display()
        )
    })?;
    let timeout = Some(Duration::from_millis(timeout_ms));
    let _ = stream.set_read_timeout(timeout);
    let _ = stream.set_write_timeout(timeout);
    let line = format!(
        "{}\n",
        serde_json::to_string(&request).map_err(|error| error.to_string())?
    );
    stream
        .write_all(line.as_bytes())
        .map_err(|error| error.to_string())?;
    let mut response = Vec::new();
    let mut byte = [0u8; 1];
    loop {
        let read = stream.read(&mut byte).map_err(|error| error.to_string())?;
        if read == 0 || byte[0] == b'\n' {
            break;
        }
        response.push(byte[0]);
    }
    if response.is_empty() {
        return Err("browser-control socket returned an empty response".to_string());
    }
    serde_json::from_slice(&response).map_err(|error| error.to_string())
}

#[cfg(not(unix))]
fn call_agent_socket(_request: Value, _timeout_ms: u64) -> Result<Value, String> {
    Err("browser-control socket bridge is not available on this platform yet".to_string())
}

#[cfg(unix)]
fn resolve_socket_path() -> PathBuf {
    if let Ok(path) = std::env::var("REDBOX_BROWSER_CONTROL_SOCKET") {
        let trimmed = path.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }
    if let Some(path) = endpoint_state_socket_path() {
        return path;
    }
    let uid = std::env::var("UID")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "user".to_string());
    std::env::temp_dir().join(format!("redbox-browser-control-{uid}.sock"))
}

#[cfg(unix)]
fn endpoint_state_socket_path() -> Option<PathBuf> {
    let path = dirs::home_dir()?
        .join("Library")
        .join("Application Support")
        .join("RedBox")
        .join("native-host")
        .join("browser-control-agent-endpoint.json");
    let content = std::fs::read_to_string(path).ok()?;
    let value = serde_json::from_str::<Value>(&content).ok()?;
    value
        .get("socketPath")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::persistence::default_store;

    #[test]
    fn stdio_parser_reads_content_length_messages() {
        let mut input =
            b"Content-Length: 40\r\n\r\n{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"ping\"}"
                .to_vec();
        let message = take_stdio_message(&mut input).unwrap().unwrap();
        assert_eq!(message.get("method").and_then(Value::as_str), Some("ping"));
        assert!(input.is_empty());
    }

    #[test]
    fn seed_adds_builtin_server_and_preserves_user_enabled_state() {
        let mut store = default_store();
        assert!(ensure_builtin_browser_control_mcp(&mut store));
        let server = store
            .mcp_servers
            .iter_mut()
            .find(|server| server.id == SERVER_ID)
            .expect("builtin server");
        assert_eq!(server.transport, "stdio");
        assert_eq!(server.args.as_ref().unwrap(), &vec![MCP_ARG.to_string()]);
        server.enabled = false;
        server.command = Some("stale".to_string());
        assert!(ensure_builtin_browser_control_mcp(&mut store));
        let server = store
            .mcp_servers
            .iter()
            .find(|server| server.id == SERVER_ID)
            .expect("builtin server");
        assert!(!server.enabled);
        assert_ne!(server.command.as_deref(), Some("stale"));
    }
}
