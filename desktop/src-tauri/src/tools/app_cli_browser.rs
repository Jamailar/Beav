use super::*;
use crate::mcp::resources::McpCapabilitySnapshot;
use crate::mcp::tool_inventory::McpToolInfo;
use crate::store::mcp_tools as mcp_tools_store;

const BROWSER_CONTROL_SERVER_ID: &str = "builtin:redbox-browser-control";

pub(super) fn handle(executor: &AppCliExecutor<'_>, payload: &Value) -> Result<Value, String> {
    let operation = payload_string(payload, "operation")
        .or_else(|| payload_string(payload, "method"))
        .or_else(|| payload_string(payload, "command"))
        .map(|value| normalized_app_cli_action_key(&value))
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            app_cli_error_json(
                Some("browser.control"),
                "OPERATION_REQUIRED",
                "browser.control requires an operation",
                false,
                Some(json!({
                    "operations": supported_browser_operations(),
                })),
            )
        })?;
    let action = browser_action_for_operation(&operation).ok_or_else(|| {
        app_cli_error_json(
            Some("browser.control"),
            "UNSUPPORTED_OPERATION",
            &format!("unsupported browser.control operation: {operation}"),
            false,
            Some(json!({
                "operations": supported_browser_operations(),
            })),
        )
    })?;
    let arguments =
        build_browser_action_arguments(&operation, action, payload, executor.session_id);
    let result = call_browser_control_tool(executor, action, arguments)?;
    if let Some(error) = browser_control_response_error(&result.response) {
        let message = error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("browser-control action failed");
        let code = if message.contains("failed to connect browser-control socket")
            || message.contains("No such file or directory")
        {
            "BROWSER_CONTROL_UNAVAILABLE"
        } else {
            "BROWSER_ACTION_FAILED"
        };
        return Err(app_cli_error_json(
            Some("browser.control"),
            code,
            message,
            true,
            Some(json!({
                "operation": operation,
                "browserAction": action,
                "backend": BROWSER_CONTROL_SERVER_ID,
                "diagnostic": "Run `pnpm diagnose:browser-control -- --no-fail` in Plugin/ to check extension, native host manifest, endpoint state, and socket forwarding.",
                "mcpError": error,
            })),
        ));
    }
    let capability_summary = browser_control_capability_summary(&result.capabilities);
    Ok(json!({
        "success": true,
        "operation": operation,
        "browserAction": action,
        "data": result.response,
        "session": result.session,
        "capabilities": capability_summary,
        "facade": {
            "kind": "redbox_browser_runtime",
            "contract": "codex_style_browser_facade",
            "backend": BROWSER_CONTROL_SERVER_ID
        }
    }))
}

fn call_browser_control_tool(
    executor: &AppCliExecutor<'_>,
    raw_tool_name: &str,
    arguments: Value,
) -> Result<crate::mcp::McpInvocationResult, String> {
    let servers = with_store(executor.state, |store| {
        Ok::<_, String>(mcp_tools_store::list_servers(&store))
    })?;
    let server = servers
        .iter()
        .find(|server| server.id == BROWSER_CONTROL_SERVER_ID)
        .ok_or_else(|| {
            app_cli_error_json(
                Some("browser.control"),
                "BROWSER_BACKEND_NOT_CONFIGURED",
                "RedBox Browser Control backend is not configured",
                true,
                Some(json!({
                    "serverId": BROWSER_CONTROL_SERVER_ID,
                })),
            )
        })?;
    if !server.enabled {
        return Err(app_cli_error_json(
            Some("browser.control"),
            "BROWSER_BACKEND_DISABLED",
            "RedBox Browser Control backend is disabled",
            true,
            Some(json!({
                "serverId": BROWSER_CONTROL_SERVER_ID,
            })),
        ));
    }
    executor.state.mcp_manager.call_tool(
        &servers,
        &McpToolInfo {
            server_id: BROWSER_CONTROL_SERVER_ID.to_string(),
            server_name: "RedBox Browser Control".to_string(),
            raw_tool_name: raw_tool_name.to_string(),
            callable_name: format!("browser.control/{raw_tool_name}"),
            ..McpToolInfo::default()
        },
        arguments,
    )
}

fn browser_control_response_error(response: &Value) -> Option<Value> {
    let error = response.get("error")?;
    if error.is_null() {
        return None;
    }
    Some(error.clone())
}

fn browser_control_capability_summary(capabilities: &McpCapabilitySnapshot) -> Value {
    json!({
        "connectionStrategy": capabilities.connection_strategy,
        "serverName": capabilities.server_name(),
        "protocolVersion": capabilities.protocol_version(),
        "toolCount": capabilities.tool_count(),
        "resourceCount": capabilities.resource_count(),
        "resourceTemplateCount": capabilities.resource_template_count(),
    })
}

fn browser_action_for_operation(operation: &str) -> Option<&'static str> {
    Some(match operation {
        "capabilities" | "documentation" | "docs" => "browser.capabilities",
        "info" | "getinfo" => "browser.info",
        "namesession" | "sessionname" => "session.name",
        "turnended" | "endturn" => "turn.ended",
        "listtabs" | "tabslist" | "opentabs" | "usertabs" | "useropentabs" => "tabs.list",
        "newtab" | "tabsnew" | "createtab" | "open" => "tab.create",
        "gettab" | "tabsget" | "selected" | "selectedtab" | "tabsselected" | "tabinfo" | "url"
        | "taburl" | "title" | "tabtitle" => "tab.info",
        "claimtab" | "claim" | "userclaimtab" => "tab.claim",
        "goto" | "tabgoto" | "navigate" | "navigatetab" => "tab.navigate",
        "back" | "tabback" => "tab.back",
        "forward" | "tabforward" => "tab.forward",
        "reload" | "tabreload" | "reloadtab" => "tab.reload",
        "close" | "tabclose" | "closetab" => "tab.close",
        "finalizetabs" | "tabsfinalize" | "finalize" => "tabs.finalize",
        "waitforloadstate" | "playwrightwaitforloadstate" => "page.waitForLoadState",
        "waitforurl" | "playwrightwaitforurl" => "page.waitForURL",
        "waitfortimeout" | "waittimeout" | "sleep" => "page.waitForTimeout",
        "evaluate" | "playwrightevaluate" => "page.evaluate",
        "domsnapshot" | "playwrightdomsnapshot" | "snapshot" | "readdom" => "page.domSnapshot",
        "query" | "queryelements" | "locator" | "playwrightlocator" | "getbyrole" | "getbytext"
        | "getbylabel" | "getbyplaceholder" | "getbytestid" | "findelements" | "count"
        | "locatorcount" | "alltextcontents" | "innertext" | "textcontent" | "isenabled" => {
            "page.queryElements"
        }
        "waitforselector" | "waitselector" | "locatorwaitfor" => "page.waitForSelector",
        "click" => "page.click",
        "doubleclick" | "dblclick" => "page.doubleClick",
        "hover" => "page.hover",
        "clicknode" | "nodeclick" => "node.click",
        "scroll" => "page.scroll",
        "scrollnode" | "nodescroll" => "node.scroll",
        "type" | "fill" | "locatorfill" => "page.type",
        "check" => "page.check",
        "setchecked" => "page.setChecked",
        "uncheck" => "page.setChecked",
        "ischecked" => "page.isChecked",
        "isvisible" | "locatorisvisible" => "page.isVisible",
        "getvalue" | "inputvalue" => "page.getValue",
        "getvalues" => "page.getValues",
        "getattribute" => "page.getAttribute",
        "select" | "selectoption" => "page.select",
        "screenshot" => "page.screenshot",
        "assets" | "pageassets" => "page.assets",
        "frames" | "listframes" => "page.frames",
        "consolelogs" | "logs" => "page.consoleLogs",
        "readclipboard" => "clipboard.read",
        "readclipboardtext" => "clipboard.readText",
        "writeclipboard" => "clipboard.write",
        "writeclipboardtext" => "clipboard.writeText",
        "mousemove" | "cuamove" => "input.mouseMove",
        "mouseclick" | "cuaclick" | "coordinateclick" => "input.mouseClick",
        "mousedrag" | "cuadrag" => "input.mouseDrag",
        "mousewheel" | "cuascroll" | "wheel" => "input.mouseWheel",
        "keyboardtype" | "cuatype" => "input.keyboardType",
        "press" | "locatorpress" | "keypress" | "keyboardpress" | "cuakeypress" => {
            "input.keyboardPress"
        }
        "keyboardcombo" | "keycombo" => "input.keyboardCombo",
        "visibility" | "getvisibility" => "browser.visibility.get",
        "setvisibility" => "browser.visibility.set",
        "viewportstate" | "viewport" => "viewport.state",
        "setviewport" => "viewport.set",
        "resetviewport" => "viewport.reset",
        "history" | "searchhistory" | "userhistory" => "history.search",
        "browsercontext" | "usercontext" | "userbrowsercontext" => "browser.context",
        "windows" | "listwindows" => "windows.list",
        "events" => "browser.events",
        "eventsummary" | "eventssummary" => "browser.events.summary",
        "sessionevents" => "browser.sessionEvents",
        "cdp" | "cdpsend" | "executecdp" => "cdp.send",
        _ => return None,
    })
}

fn build_browser_action_arguments(
    operation: &str,
    raw_tool_name: &str,
    payload: &Value,
    session_id: Option<&str>,
) -> Value {
    let mut object = payload.as_object().cloned().unwrap_or_default();
    object.remove("__compat");
    object.remove("operation");
    object.remove("method");
    object.remove("command");
    normalize_browser_payload_aliases(operation, raw_tool_name, &mut object);
    object.insert("type".to_string(), json!(raw_tool_name));
    if !object.contains_key("sessionId") {
        if let Some(session_id) = session_id.filter(|value| !value.trim().is_empty()) {
            object.insert("sessionId".to_string(), json!(session_id));
        }
    }
    if raw_tool_name == "tabs.finalize" && !object.contains_key("keep") {
        if let Some(tabs) = object.remove("tabs") {
            object.insert("keep".to_string(), tabs);
        }
    }
    Value::Object(object)
}

fn normalize_browser_payload_aliases(
    operation: &str,
    raw_tool_name: &str,
    object: &mut serde_json::Map<String, Value>,
) {
    if browser_action_targets_existing_tab(raw_tool_name) && !object.contains_key("tabId") {
        if let Some(id) = object.get("id").cloned() {
            object.insert("tabId".to_string(), id);
        }
    }
    if matches!(
        raw_tool_name,
        "page.type" | "input.keyboardType" | "clipboard.writeText"
    ) && !has_non_empty_string(object, "text")
    {
        if let Some(value) = object.get("value").cloned() {
            object.insert("text".to_string(), value);
        }
    }
    if raw_tool_name == "page.waitForLoadState" && !has_non_empty_string(object, "state") {
        if let Some(wait_until) = object.get("waitUntil").cloned() {
            object.insert("state".to_string(), wait_until);
        }
    }
    if raw_tool_name == "page.evaluate"
        && !has_non_empty_string(object, "script")
        && !has_non_empty_string(object, "expression")
    {
        if let Some(page_function) = object.get("pageFunction").cloned() {
            object.insert("script".to_string(), page_function);
        }
    }
    if operation == "uncheck"
        && raw_tool_name == "page.setChecked"
        && !object.contains_key("checked")
    {
        object.insert("checked".to_string(), json!(false));
    }
    if raw_tool_name == "page.queryElements" {
        match operation {
            "count" | "locatorcount" => {
                object.entry("all".to_string()).or_insert(json!(true));
                object.entry("mode".to_string()).or_insert(json!("count"));
            }
            "alltextcontents" => {
                object.entry("all".to_string()).or_insert(json!(true));
                object.entry("mode".to_string()).or_insert(json!("all"));
            }
            _ => {}
        }
    }
    if browser_action_uses_dom_target(raw_tool_name) {
        if !has_non_empty_string(object, "text") {
            if let Some(name) = object.get("name").cloned() {
                object.insert("text".to_string(), name);
            } else if let Some(label) = object.get("label").cloned() {
                object.insert("text".to_string(), label);
            }
        }
        if !has_non_empty_string(object, "selector") {
            if let Some(selector) = selector_from_test_id(object) {
                object.insert("selector".to_string(), json!(selector));
            } else if let Some(selector) = selector_from_placeholder(object) {
                object.insert("selector".to_string(), json!(selector));
            } else if !has_non_empty_string(object, "text") {
                if let Some(selector) = selector_from_role(object) {
                    object.insert("selector".to_string(), json!(selector));
                }
            }
        }
    }
}

fn browser_action_targets_existing_tab(raw_tool_name: &str) -> bool {
    raw_tool_name == "tab.info"
        || raw_tool_name == "tab.claim"
        || raw_tool_name == "tab.navigate"
        || raw_tool_name == "tab.back"
        || raw_tool_name == "tab.forward"
        || raw_tool_name == "tab.reload"
        || raw_tool_name == "tab.close"
        || raw_tool_name.starts_with("page.")
        || raw_tool_name.starts_with("node.")
        || raw_tool_name.starts_with("clipboard.")
        || raw_tool_name.starts_with("input.")
}

fn browser_action_uses_dom_target(raw_tool_name: &str) -> bool {
    matches!(
        raw_tool_name,
        "page.queryElements"
            | "page.waitForSelector"
            | "page.click"
            | "page.doubleClick"
            | "page.hover"
            | "page.type"
            | "page.check"
            | "page.setChecked"
            | "page.isChecked"
            | "page.isVisible"
            | "page.getValue"
            | "page.getValues"
            | "page.getAttribute"
            | "page.select"
    )
}

fn has_non_empty_string(object: &serde_json::Map<String, Value>, key: &str) -> bool {
    object
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .is_some_and(|value| !value.is_empty())
}

fn selector_from_test_id(object: &serde_json::Map<String, Value>) -> Option<String> {
    let value = object.get("testId").and_then(Value::as_str)?.trim();
    if value.is_empty() {
        return None;
    }
    let escaped = css_string_literal(value);
    Some(format!(
        "[data-testid=\"{escaped}\"],[data-test=\"{escaped}\"],[data-test-id=\"{escaped}\"]"
    ))
}

fn selector_from_placeholder(object: &serde_json::Map<String, Value>) -> Option<String> {
    let value = object.get("placeholder").and_then(Value::as_str)?.trim();
    if value.is_empty() {
        return None;
    }
    let escaped = css_string_literal(value);
    Some(format!(
        "input[placeholder=\"{escaped}\"],textarea[placeholder=\"{escaped}\"]"
    ))
}

fn selector_from_role(object: &serde_json::Map<String, Value>) -> Option<String> {
    let value = object.get("role").and_then(Value::as_str)?.trim();
    if value.is_empty()
        || !value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_'))
    {
        return None;
    }
    Some(format!("[role=\"{}\"]", css_string_literal(value)))
}

fn css_string_literal(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

fn supported_browser_operations() -> Vec<&'static str> {
    vec![
        "capabilities",
        "info",
        "documentation",
        "nameSession",
        "turnEnded",
        "listTabs",
        "newTab",
        "getTab",
        "selectedTab",
        "open",
        "claimTab",
        "goto",
        "back",
        "forward",
        "reload",
        "close",
        "finalizeTabs",
        "waitForLoadState",
        "waitForURL",
        "waitForTimeout",
        "evaluate",
        "domSnapshot",
        "queryElements",
        "count",
        "allTextContents",
        "innerText",
        "textContent",
        "isEnabled",
        "waitForSelector",
        "click",
        "doubleClick",
        "hover",
        "clickNode",
        "scroll",
        "scrollNode",
        "type",
        "check",
        "setChecked",
        "uncheck",
        "isChecked",
        "isVisible",
        "getValue",
        "getValues",
        "getAttribute",
        "select",
        "screenshot",
        "assets",
        "frames",
        "consoleLogs",
        "readClipboard",
        "readClipboardText",
        "writeClipboard",
        "writeClipboardText",
        "mouseMove",
        "mouseClick",
        "mouseDrag",
        "mouseWheel",
        "keyboardType",
        "keyPress",
        "press",
        "keyboardCombo",
        "visibility",
        "setVisibility",
        "viewportState",
        "setViewport",
        "resetViewport",
        "history",
        "browserContext",
        "windows",
        "events",
        "eventSummary",
        "sessionEvents",
        "cdp",
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_codex_style_operations_to_browser_actions() {
        assert_eq!(browser_action_for_operation("newtab"), Some("tab.create"));
        assert_eq!(browser_action_for_operation("goto"), Some("tab.navigate"));
        assert_eq!(browser_action_for_operation("tabback"), Some("tab.back"));
        assert_eq!(
            browser_action_for_operation("tabforward"),
            Some("tab.forward")
        );
        assert_eq!(browser_action_for_operation("tabsget"), Some("tab.info"));
        assert_eq!(browser_action_for_operation("taburl"), Some("tab.info"));
        assert_eq!(
            browser_action_for_operation("waitforloadstate"),
            Some("page.waitForLoadState")
        );
        assert_eq!(
            browser_action_for_operation("waitforurl"),
            Some("page.waitForURL")
        );
        assert_eq!(
            browser_action_for_operation("waitfortimeout"),
            Some("page.waitForTimeout")
        );
        assert_eq!(
            browser_action_for_operation("evaluate"),
            Some("page.evaluate")
        );
        assert_eq!(
            browser_action_for_operation("domsnapshot"),
            Some("page.domSnapshot")
        );
        assert_eq!(
            browser_action_for_operation("getbyrole"),
            Some("page.queryElements")
        );
        assert_eq!(
            browser_action_for_operation("alltextcontents"),
            Some("page.queryElements")
        );
        assert_eq!(
            browser_action_for_operation("waitforselector"),
            Some("page.waitForSelector")
        );
        assert_eq!(
            browser_action_for_operation("doubleclick"),
            Some("page.doubleClick")
        );
        assert_eq!(browser_action_for_operation("scroll"), Some("page.scroll"));
        assert_eq!(
            browser_action_for_operation("keyboardpress"),
            Some("input.keyboardPress")
        );
        assert_eq!(
            browser_action_for_operation("locatorpress"),
            Some("input.keyboardPress")
        );
        assert_eq!(
            browser_action_for_operation("readclipboardtext"),
            Some("clipboard.readText")
        );
        assert_eq!(
            browser_action_for_operation("finalizetabs"),
            Some("tabs.finalize")
        );
        assert_eq!(
            browser_action_for_operation("namesession"),
            Some("session.name")
        );
    }

    #[test]
    fn browser_action_arguments_add_type_and_session_id() {
        let args = build_browser_action_arguments(
            "goto",
            "tab.navigate",
            &json!({
                "operation": "goto",
                "tabId": 123,
                "url": "https://example.com"
            }),
            Some("session-1"),
        );
        assert_eq!(
            args.get("type").and_then(Value::as_str),
            Some("tab.navigate")
        );
        assert_eq!(
            args.get("sessionId").and_then(Value::as_str),
            Some("session-1")
        );
        assert_eq!(args.get("operation"), None);
        assert_eq!(
            args.get("url").and_then(Value::as_str),
            Some("https://example.com")
        );
    }

    #[test]
    fn browser_action_arguments_normalize_codex_payload_aliases() {
        let args = build_browser_action_arguments(
            "fill",
            "page.type",
            &json!({
                "operation": "fill",
                "id": "42",
                "testId": "search-input",
                "value": "world cup"
            }),
            None,
        );
        assert_eq!(args.get("tabId").and_then(Value::as_str), Some("42"));
        assert_eq!(args.get("text").and_then(Value::as_str), Some("world cup"));
        assert_eq!(
            args.get("selector").and_then(Value::as_str),
            Some("[data-testid=\"search-input\"],[data-test=\"search-input\"],[data-test-id=\"search-input\"]")
        );
    }

    #[test]
    fn wait_for_load_state_accepts_codex_wait_until_alias() {
        let args = build_browser_action_arguments(
            "waitforloadstate",
            "page.waitForLoadState",
            &json!({
                "tabId": 7,
                "waitUntil": "networkidle"
            }),
            None,
        );
        assert_eq!(
            args.get("state").and_then(Value::as_str),
            Some("networkidle")
        );
    }

    #[test]
    fn query_read_operations_request_all_matches_when_needed() {
        let args = build_browser_action_arguments(
            "alltextcontents",
            "page.queryElements",
            &json!({
                "tabId": 7,
                "selector": ".item"
            }),
            None,
        );
        assert_eq!(args.get("all").and_then(Value::as_bool), Some(true));
        assert_eq!(args.get("mode").and_then(Value::as_str), Some("all"));
    }

    #[test]
    fn browser_control_capability_summary_omits_cached_tool_lists() {
        let summary = browser_control_capability_summary(&McpCapabilitySnapshot {
            connection_strategy: "persistent".to_string(),
            initialize_response: Some(json!({
                "result": {
                    "protocolVersion": "2024-11-05",
                    "serverInfo": { "name": "redbox-browser-control" }
                }
            })),
            tools_response: Some(json!({
                "result": {
                    "tools": [
                        { "name": "tabs.list", "description": "List tabs" },
                        { "name": "page.queryElements", "description": "Query elements" }
                    ]
                }
            })),
            resources_response: Some(json!({ "result": { "resources": [] } })),
            resource_templates_response: Some(json!({ "result": { "resourceTemplates": [] } })),
        });

        assert_eq!(
            summary.get("serverName").and_then(Value::as_str),
            Some("redbox-browser-control")
        );
        assert_eq!(
            summary.get("protocolVersion").and_then(Value::as_str),
            Some("2024-11-05")
        );
        assert_eq!(summary.get("toolCount").and_then(Value::as_u64), Some(2));
        assert!(summary.get("toolsResponse").is_none());
        assert!(summary.get("initializeResponse").is_none());
    }

    #[test]
    fn uncheck_defaults_set_checked_to_false() {
        let args = build_browser_action_arguments(
            "uncheck",
            "page.setChecked",
            &json!({
                "tabId": 7,
                "selector": "#enabled"
            }),
            None,
        );
        assert_eq!(args.get("checked").and_then(Value::as_bool), Some(false));
    }

    #[test]
    fn finalize_tabs_accepts_codex_keep_payload() {
        let args = build_browser_action_arguments(
            "finalizetabs",
            "tabs.finalize",
            &json!({
                "operation": "finalizeTabs",
                "tabs": [{ "tabId": 1, "status": "deliverable" }]
            }),
            None,
        );
        assert!(args.get("keep").and_then(Value::as_array).is_some());
        assert!(args.get("tabs").is_none());
    }

    #[test]
    fn detects_browser_control_json_rpc_error_response() {
        let error = browser_control_response_error(&json!({
            "jsonrpc": "2.0",
            "id": 8,
            "error": {
                "code": -32000,
                "message": "failed to connect browser-control socket /tmp/missing.sock: No such file or directory (os error 2)"
            }
        }))
        .unwrap();
        assert_eq!(error.get("code").and_then(Value::as_i64), Some(-32000));
        assert!(error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .contains("failed to connect browser-control socket"));
    }
}
