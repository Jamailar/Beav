use serde_json::{Map, Value, json};

pub struct NormalizedToolCall {
    pub name: &'static str,
    pub arguments: Value,
}

pub fn canonical_tool_name(name: &str) -> &str {
    match name.trim() {
        "app_cli"
        | "redbox_app_query"
        | "redbox_profile_doc"
        | "redbox_mcp"
        | "redbox_skill"
        | "redbox_runtime_control"
        | "redbox_list_spaces"
        | "redbox_list_advisors"
        | "redbox_search_knowledge"
        | "redbox_list_work_items"
        | "redbox_search_memory"
        | "redbox_list_chat_sessions"
        | "redbox_get_settings_summary"
        | "redbox_list_redclaw_projects"
        | "redclaw_update_profile_doc"
        | "redclaw_update_creator_profile" => "app_cli",
        "bash" => "bash",
        "redbox_fs"
        | "redbox_list_directory"
        | "redbox_read_path"
        | "knowledge_glob"
        | "knowledge_grep"
        | "knowledge_read" => "redbox_fs",
        "redbox_editor" => "redbox_editor",
        other => other,
    }
}

pub fn normalize_tool_call(name: &str, arguments: &Value) -> NormalizedToolCall {
    match name {
        "app_cli" => passthrough("app_cli", arguments),
        "bash" => passthrough("bash", arguments),
        "redbox_list_spaces" => app_query("spaces.list", arguments),
        "redbox_list_advisors" => app_query("advisors.list", arguments),
        "redbox_search_knowledge" => app_query("knowledge.search", arguments),
        "redbox_list_work_items" => app_query("work.list", arguments),
        "redbox_search_memory" => app_query("memory.search", arguments),
        "redbox_list_chat_sessions" => app_query("chat.sessions.list", arguments),
        "redbox_get_settings_summary" => app_query("settings.summary", arguments),
        "redbox_list_redclaw_projects" => app_query("redclaw.projects.list", arguments),
        "redbox_list_directory" => fs_call("list", arguments),
        "redbox_read_path" => fs_call("read", arguments),
        "knowledge_glob" => knowledge_fs_call("list", arguments),
        "knowledge_grep" => knowledge_fs_call("search", arguments),
        "knowledge_read" => knowledge_fs_call("read", arguments),
        "redclaw_update_profile_doc" => profile_update(arguments),
        "redclaw_update_creator_profile" => creator_profile_update(arguments),
        "redbox_mcp" => mcp_to_app_cli(arguments),
        "redbox_skill" => skill_to_app_cli(arguments),
        "redbox_runtime_control" => runtime_to_app_cli(arguments),
        "redbox_app_query" => app_query_direct(arguments),
        "redbox_fs" => passthrough("redbox_fs", arguments),
        "redbox_profile_doc" => profile_doc_to_app_cli(arguments),
        "redbox_editor" => passthrough("redbox_editor", arguments),
        _ => NormalizedToolCall {
            name: "",
            arguments: json!({}),
        },
    }
}

fn passthrough(name: &'static str, arguments: &Value) -> NormalizedToolCall {
    NormalizedToolCall {
        name,
        arguments: if arguments.is_object() {
            arguments.clone()
        } else {
            json!({})
        },
    }
}

fn app_query(operation: &'static str, arguments: &Value) -> NormalizedToolCall {
    let mut payload = Map::new();
    copy_if_present(&mut payload, arguments, "query");
    copy_if_present(&mut payload, arguments, "status");
    copy_if_present(&mut payload, arguments, "limit");
    let command = match operation {
        "spaces.list" => "spaces list",
        "advisors.list" => "advisors list",
        "knowledge.search" => "knowledge search",
        "work.list" => "work list",
        "memory.search" => "memory search",
        "chat.sessions.list" => "chat sessions list",
        "settings.summary" => "settings summary",
        "redclaw.projects.list" => "redclaw projects",
        "redclaw.profile.bundle" => "redclaw profile-bundle",
        "redclaw.profile.onboarding" => "redclaw profile-onboarding",
        _ => "help",
    };
    app_cli_call(command, Value::Object(payload))
}

fn app_query_direct(arguments: &Value) -> NormalizedToolCall {
    let operation = arguments
        .get("operation")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let mut payload = Map::new();
    copy_if_present(&mut payload, arguments, "query");
    copy_if_present(&mut payload, arguments, "status");
    copy_if_present(&mut payload, arguments, "limit");
    let command = match operation {
        "spaces.list" => "spaces list",
        "advisors.list" => "advisors list",
        "knowledge.search" => "knowledge search",
        "work.list" => "work list",
        "memory.search" => "memory search",
        "chat.sessions.list" => "chat sessions list",
        "settings.summary" => "settings summary",
        "redclaw.projects.list" => "redclaw projects",
        "redclaw.profile.bundle" => "redclaw profile-bundle",
        "redclaw.profile.onboarding" => "redclaw profile-onboarding",
        _ => "help",
    };
    app_cli_call(command, Value::Object(payload))
}

fn fs_call(action: &'static str, arguments: &Value) -> NormalizedToolCall {
    let mut payload = Map::new();
    payload.insert("action".to_string(), json!(action));
    copy_if_present(&mut payload, arguments, "path");
    copy_if_present(&mut payload, arguments, "limit");
    copy_if_present(&mut payload, arguments, "maxChars");
    NormalizedToolCall {
        name: "redbox_fs",
        arguments: Value::Object(payload),
    }
}

fn knowledge_fs_call(action: &'static str, arguments: &Value) -> NormalizedToolCall {
    let mut payload = Map::new();
    payload.insert("scope".to_string(), json!("knowledge"));
    payload.insert("action".to_string(), json!(action));
    copy_if_present(&mut payload, arguments, "advisorId");
    copy_if_present(&mut payload, arguments, "path");
    copy_if_present(&mut payload, arguments, "pattern");
    copy_if_present(&mut payload, arguments, "query");
    copy_if_present(&mut payload, arguments, "offset");
    copy_if_present(&mut payload, arguments, "limit");
    copy_if_present(&mut payload, arguments, "maxChars");
    copy_if_present(&mut payload, arguments, "snippetChars");
    NormalizedToolCall {
        name: "redbox_fs",
        arguments: Value::Object(payload),
    }
}

fn profile_update(arguments: &Value) -> NormalizedToolCall {
    let mut payload = Map::new();
    copy_if_present(&mut payload, arguments, "docType");
    copy_if_present(&mut payload, arguments, "markdown");
    copy_if_present(&mut payload, arguments, "reason");
    app_cli_call("redclaw profile-update", Value::Object(payload))
}

fn creator_profile_update(arguments: &Value) -> NormalizedToolCall {
    let mut payload = Map::new();
    payload.insert("docType".to_string(), json!("creator_profile"));
    copy_if_present(&mut payload, arguments, "markdown");
    copy_if_present(&mut payload, arguments, "reason");
    app_cli_call("redclaw profile-update", Value::Object(payload))
}

fn profile_doc_to_app_cli(arguments: &Value) -> NormalizedToolCall {
    let action = arguments
        .get("action")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let mut payload = Map::new();
    copy_if_present(&mut payload, arguments, "docType");
    copy_if_present(&mut payload, arguments, "markdown");
    copy_if_present(&mut payload, arguments, "reason");
    let command = match action {
        "bundle" => "redclaw profile-bundle",
        "read" => "redclaw profile-read",
        "update" => "redclaw profile-update",
        _ => "help",
    };
    app_cli_call(command, Value::Object(payload))
}

fn mcp_to_app_cli(arguments: &Value) -> NormalizedToolCall {
    let action = arguments
        .get("action")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let command = match action {
        "list" => "mcp list",
        "save" => "mcp save",
        "test" => "mcp test",
        "call" => "mcp call",
        "list_tools" => "mcp list-tools",
        "list_resources" => "mcp list-resources",
        "list_resource_templates" => "mcp list-resource-templates",
        "sessions" => "mcp sessions",
        "disconnect" => "mcp disconnect",
        "disconnect_all" => "mcp disconnect-all",
        "discover_local" => "mcp discover-local",
        "import_local" => "mcp import-local",
        "oauth_status" => "mcp oauth-status",
        _ => "help",
    };
    app_cli_call(command, arguments.clone())
}

fn skill_to_app_cli(arguments: &Value) -> NormalizedToolCall {
    let action = arguments
        .get("action")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let command = match action {
        "list" => "skills list",
        "invoke" => "skills invoke",
        "create" => "skills create",
        "save" => "skills save",
        "enable" => "skills enable",
        "disable" => "skills disable",
        "market_install" => "skills market-install",
        "ai_roles_list" => "ai roles-list",
        "detect_protocol" => "ai detect-protocol",
        "test_connection" => "ai test-connection",
        "fetch_models" => "ai fetch-models",
        _ => "help",
    };
    app_cli_call(command, arguments.clone())
}

fn runtime_to_app_cli(arguments: &Value) -> NormalizedToolCall {
    let action = arguments
        .get("action")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let command = match action {
        "runtime_query" => "runtime query",
        "runtime_resume" => "runtime resume",
        "runtime_fork_session" => "runtime fork-session",
        "runtime_get_trace" => "runtime get-trace",
        "runtime_get_checkpoints" => "runtime get-checkpoints",
        "runtime_get_tool_results" => "runtime get-tool-results",
        "tasks_create" => "runtime tasks create",
        "tasks_list" => "runtime tasks list",
        "tasks_get" => "runtime tasks get",
        "tasks_resume" => "runtime tasks resume",
        "tasks_cancel" => "runtime tasks cancel",
        "background_tasks_list" => "runtime background list",
        "background_tasks_get" => "runtime background get",
        "background_tasks_cancel" => "runtime background cancel",
        "session_enter_diagnostics" => "runtime session-enter-diagnostics",
        "session_bridge_status" => "runtime session-bridge status",
        "session_bridge_list_sessions" => "runtime session-bridge list-sessions",
        "session_bridge_get_session" => "runtime session-bridge get-session",
        _ => "help",
    };
    app_cli_call(command, arguments.clone())
}

fn app_cli_call(command: &'static str, payload: Value) -> NormalizedToolCall {
    let mut arguments = Map::new();
    arguments.insert("command".to_string(), json!(command));
    if payload.is_object() {
        arguments.insert("payload".to_string(), payload);
    }
    NormalizedToolCall {
        name: "app_cli",
        arguments: Value::Object(arguments),
    }
}

fn copy_if_present(target: &mut Map<String, Value>, source: &Value, key: &str) {
    if let Some(value) = source.get(key) {
        target.insert(key.to_string(), value.clone());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_runtime_control_to_app_cli() {
        let normalized =
            normalize_tool_call("redbox_runtime_control", &json!({ "action": "tasks_list" }));

        assert_eq!(normalized.name, "app_cli");
        assert_eq!(
            normalized.arguments.get("command"),
            Some(&json!("runtime tasks list"))
        );
    }

    #[test]
    fn normalizes_profile_doc_to_app_cli() {
        let normalized = normalize_tool_call(
            "redbox_profile_doc",
            &json!({ "action": "read", "docType": "user" }),
        );

        assert_eq!(normalized.name, "app_cli");
        assert_eq!(
            normalized.arguments.get("command"),
            Some(&json!("redclaw profile-read"))
        );
        assert_eq!(
            normalized
                .arguments
                .get("payload")
                .and_then(|value| value.get("docType")),
            Some(&json!("user"))
        );
    }

    #[test]
    fn normalizes_mcp_to_app_cli() {
        let normalized = normalize_tool_call(
            "redbox_mcp",
            &json!({ "action": "oauth_status", "serverId": "server-1" }),
        );

        assert_eq!(normalized.name, "app_cli");
        assert_eq!(
            normalized.arguments.get("command"),
            Some(&json!("mcp oauth-status"))
        );
    }
}
