use serde_json::{json, Map, Value};

pub struct NormalizedToolCall {
    pub name: &'static str,
    pub arguments: Value,
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
        "redclaw_update_profile_doc" => profile_update(arguments),
        "redclaw_update_creator_profile" => creator_profile_update(arguments),
        "redbox_mcp" => passthrough("redbox_mcp", arguments),
        "redbox_skill" => passthrough("redbox_skill", arguments),
        "redbox_runtime_control" => passthrough("redbox_runtime_control", arguments),
        "redbox_app_query" => passthrough("redbox_app_query", arguments),
        "redbox_fs" => passthrough("redbox_fs", arguments),
        "redbox_profile_doc" => passthrough("redbox_profile_doc", arguments),
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
    payload.insert("operation".to_string(), json!(operation));
    copy_if_present(&mut payload, arguments, "query");
    copy_if_present(&mut payload, arguments, "status");
    copy_if_present(&mut payload, arguments, "limit");
    NormalizedToolCall {
        name: "redbox_app_query",
        arguments: Value::Object(payload),
    }
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

fn profile_update(arguments: &Value) -> NormalizedToolCall {
    let mut payload = Map::new();
    payload.insert("action".to_string(), json!("update"));
    copy_if_present(&mut payload, arguments, "docType");
    copy_if_present(&mut payload, arguments, "markdown");
    NormalizedToolCall {
        name: "redbox_profile_doc",
        arguments: Value::Object(payload),
    }
}

fn creator_profile_update(arguments: &Value) -> NormalizedToolCall {
    let mut payload = Map::new();
    payload.insert("action".to_string(), json!("update"));
    payload.insert("docType".to_string(), json!("creator_profile"));
    copy_if_present(&mut payload, arguments, "markdown");
    NormalizedToolCall {
        name: "redbox_profile_doc",
        arguments: Value::Object(payload),
    }
}

fn copy_if_present(target: &mut Map<String, Value>, source: &Value, key: &str) {
    if let Some(value) = source.get(key) {
        target.insert(key.to_string(), value.clone());
    }
}
