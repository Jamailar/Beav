use serde_json::{json, Map, Value};

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
        "app_cli" => normalize_app_cli_call(arguments),
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
        "redbox_fs" => normalize_redbox_fs_call(arguments),
        "redbox_profile_doc" => profile_doc_to_app_cli(arguments),
        "redbox_editor" => normalize_redbox_editor_call(arguments),
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

fn compat_metadata_value(
    legacy_tool_name: Option<&str>,
    legacy_command: Option<&str>,
    translated_action: Option<&str>,
) -> Option<Value> {
    let mut object = Map::new();
    if let Some(value) = legacy_tool_name.filter(|item| !item.trim().is_empty()) {
        object.insert("legacyToolName".to_string(), json!(value));
    }
    if let Some(value) = legacy_command.filter(|item| !item.trim().is_empty()) {
        object.insert("legacyCommand".to_string(), json!(value));
    }
    if let Some(value) = translated_action.filter(|item| !item.trim().is_empty()) {
        object.insert("translatedAction".to_string(), json!(value));
    }
    if object.is_empty() {
        None
    } else {
        Some(Value::Object(object))
    }
}

fn normalize_app_cli_call(arguments: &Value) -> NormalizedToolCall {
    let Some(object) = arguments.as_object() else {
        return NormalizedToolCall {
            name: "app_cli",
            arguments: json!({}),
        };
    };
    if let Some(action) = object.get("action").and_then(Value::as_str) {
        let normalized_action = normalize_action_token(action);
        let mut normalized = object.clone();
        normalized.insert("action".to_string(), json!(normalized_action.clone()));
        if normalized_action != action.trim() {
            if let Some(metadata) =
                compat_metadata_value(Some("app_cli"), None, Some(&normalized_action))
            {
                normalized.insert("__compat".to_string(), metadata);
            }
        }
        return NormalizedToolCall {
            name: "app_cli",
            arguments: Value::Object(normalized),
        };
    }
    let command = object
        .get("command")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default();
    let payload = object.get("payload").cloned().unwrap_or_else(|| json!({}));
    if command.is_empty() {
        let mut normalized = object.clone();
        if let Some(metadata) = compat_metadata_value(Some("app_cli"), Some(""), None) {
            normalized.insert("__compat".to_string(), metadata);
        }
        return NormalizedToolCall {
            name: "app_cli",
            arguments: Value::Object(normalized),
        };
    }
    translate_legacy_app_cli_command(command, &payload)
}

fn normalize_redbox_editor_call(arguments: &Value) -> NormalizedToolCall {
    let Some(object) = arguments.as_object() else {
        return passthrough("redbox_editor", arguments);
    };
    let mut normalized = flatten_payload_fields(object);
    let Some(action) = normalized
        .get("action")
        .and_then(Value::as_str)
        .map(ToString::to_string)
    else {
        return NormalizedToolCall {
            name: "redbox_editor",
            arguments: Value::Object(normalized),
        };
    };
    let normalized_action = normalize_action_token(&action);
    normalized.insert("action".to_string(), json!(normalized_action.clone()));
    if normalized_action != action.trim() {
        if let Some(metadata) = compat_metadata_value(
            Some("redbox_editor"),
            Some(&action),
            Some(&normalized_action),
        ) {
            normalized.insert("__compat".to_string(), metadata);
        }
    }
    NormalizedToolCall {
        name: "redbox_editor",
        arguments: Value::Object(normalized),
    }
}

fn normalize_redbox_fs_call(arguments: &Value) -> NormalizedToolCall {
    let Some(object) = arguments.as_object() else {
        return passthrough("redbox_fs", arguments);
    };
    let mut normalized = flatten_payload_fields(object);
    let action = normalized
        .get("action")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default()
        .to_string();
    let scope = normalized
        .get("scope")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default()
        .to_string();
    let canonical_action = normalize_redbox_fs_action(&action, &scope);
    if !canonical_action.is_empty() {
        normalized.insert("action".to_string(), json!(canonical_action.clone()));
    }
    match scope.to_ascii_lowercase().as_str() {
        "" => {}
        "knowledge" if canonical_action.starts_with("knowledge.") => {}
        _ if canonical_action.starts_with("workspace.") => {
            normalized.remove("scope");
        }
        _ => {
            if canonical_action.starts_with("knowledge.") {
                normalized.insert("scope".to_string(), json!("knowledge"));
            }
        }
    }
    if canonical_action != action && !action.is_empty() {
        if let Some(metadata) =
            compat_metadata_value(Some("redbox_fs"), Some(&action), Some(&canonical_action))
        {
            normalized.insert("__compat".to_string(), metadata);
        }
    }
    NormalizedToolCall {
        name: "redbox_fs",
        arguments: Value::Object(normalized),
    }
}

fn normalize_action_token(value: &str) -> String {
    let trimmed = value.trim();
    match trimmed {
        "project-read" => "project_read".to_string(),
        "script-read" => "script_read".to_string(),
        "script-update" => "script_update".to_string(),
        "script-confirm" => "script_confirm".to_string(),
        "ffmpeg-edit" => "ffmpeg_edit".to_string(),
        "remotion-read" => "remotion_read".to_string(),
        "remotion-generate" => "remotion_generate".to_string(),
        "remotion-save" => "remotion_save".to_string(),
        "selection-set" => "selection_set".to_string(),
        "playhead-seek" => "playhead_seek".to_string(),
        "focus-clip" => "focus_clip".to_string(),
        "focus-item" => "focus_item".to_string(),
        "panel-open" => "panel_open".to_string(),
        "timeline-zoom-read" => "timeline_zoom_read".to_string(),
        "timeline-zoom-set" => "timeline_zoom_set".to_string(),
        "timeline-scroll-read" => "timeline_scroll_read".to_string(),
        "timeline-scroll-set" => "timeline_scroll_set".to_string(),
        "track-add" => "track_add".to_string(),
        "track-reorder" => "track_reorder".to_string(),
        "track-delete" => "track_delete".to_string(),
        "clip-add" => "clip_add".to_string(),
        "clip-insert-at-playhead" => "clip_insert_at_playhead".to_string(),
        "subtitle-add" => "subtitle_add".to_string(),
        "text-add" => "text_add".to_string(),
        "clip-update" => "clip_update".to_string(),
        "clip-move" => "clip_move".to_string(),
        "clip-toggle-enabled" => "clip_toggle_enabled".to_string(),
        "clip-delete" => "clip_delete".to_string(),
        "clip-split" => "clip_split".to_string(),
        "clip-duplicate" => "clip_duplicate".to_string(),
        "clip-replace-asset" => "clip_replace_asset".to_string(),
        "marker-add" => "marker_add".to_string(),
        "marker-update" => "marker_update".to_string(),
        "marker-delete" => "marker_delete".to_string(),
        other => other.to_string(),
    }
}

fn normalize_redbox_fs_action(action: &str, scope: &str) -> String {
    let normalized_action = action.trim().replace('_', ".").replace('-', ".");
    let normalized_scope = scope.trim().replace('_', ".").replace('-', ".");
    let combined = match normalized_action.as_str() {
        "list" | "read" | "search" => {
            let scope_prefix = if normalized_scope.eq_ignore_ascii_case("knowledge") {
                "knowledge"
            } else {
                "workspace"
            };
            format!("{scope_prefix}.{normalized_action}")
        }
        "workspace.list" | "workspace.read" | "workspace.search" | "knowledge.list"
        | "knowledge.read" | "knowledge.search" => normalized_action,
        other => other.to_string(),
    };
    match combined.as_str() {
        "workspace.list" | "workspace.read" | "workspace.search" | "knowledge.list"
        | "knowledge.read" | "knowledge.search" => combined,
        _ => combined,
    }
}

fn app_query(operation: &'static str, arguments: &Value) -> NormalizedToolCall {
    let mut payload = Map::new();
    copy_if_present(&mut payload, arguments, "query");
    copy_if_present(&mut payload, arguments, "status");
    copy_if_present(&mut payload, arguments, "limit");
    app_cli_action_or_legacy_call("redbox_app_query", operation, Value::Object(payload))
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
    app_cli_action_or_legacy_call("redbox_app_query", operation, Value::Object(payload))
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
    app_cli_action_call(
        "redclaw.profile.update",
        Value::Object(payload),
        Some("redclaw_update_profile_doc"),
        None,
    )
}

fn creator_profile_update(arguments: &Value) -> NormalizedToolCall {
    let mut payload = Map::new();
    payload.insert("docType".to_string(), json!("creator_profile"));
    copy_if_present(&mut payload, arguments, "markdown");
    copy_if_present(&mut payload, arguments, "reason");
    app_cli_action_call(
        "redclaw.profile.update",
        Value::Object(payload),
        Some("redclaw_update_creator_profile"),
        None,
    )
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
    let translated_action = match action {
        "bundle" => Some("redclaw.profile.bundle"),
        "read" => Some("redclaw.profile.read"),
        "update" => Some("redclaw.profile.update"),
        _ => None,
    };
    match translated_action {
        Some(translated) => app_cli_action_call(
            translated,
            Value::Object(payload),
            Some("redbox_profile_doc"),
            Some(action),
        ),
        None => app_cli_legacy_command_call(
            "help redclaw",
            Value::Object(payload),
            Some("redbox_profile_doc"),
            Some(action),
        ),
    }
}

fn mcp_to_app_cli(arguments: &Value) -> NormalizedToolCall {
    let action = arguments
        .get("action")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let translated_action = match action {
        "list" => Some("mcp.list"),
        "call" => Some("mcp.call"),
        "list_tools" => Some("mcp.listTools"),
        "list_resources" => Some("mcp.listResources"),
        "disconnect" => Some("mcp.disconnect"),
        _ => None,
    };
    match translated_action {
        Some(translated) => app_cli_action_call(
            translated,
            arguments.clone(),
            Some("redbox_mcp"),
            Some(action),
        ),
        None => app_cli_legacy_command_call(
            &format!("mcp {}", action.replace('_', "-")),
            arguments.clone(),
            Some("redbox_mcp"),
            Some(action),
        ),
    }
}

fn skill_to_app_cli(arguments: &Value) -> NormalizedToolCall {
    let action = arguments
        .get("action")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let translated_action = match action {
        "list" => Some("skills.list"),
        "invoke" => Some("skills.invoke"),
        _ => None,
    };
    match translated_action {
        Some(translated) => app_cli_action_call(
            translated,
            arguments.clone(),
            Some("redbox_skill"),
            Some(action),
        ),
        None => app_cli_legacy_command_call(
            &legacy_skill_command(action),
            arguments.clone(),
            Some("redbox_skill"),
            Some(action),
        ),
    }
}

fn runtime_to_app_cli(arguments: &Value) -> NormalizedToolCall {
    let action = arguments
        .get("action")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let translated_action = match action {
        "runtime_query" => Some("runtime.query"),
        "runtime_get_checkpoints" => Some("runtime.getCheckpoints"),
        "runtime_get_tool_results" => Some("runtime.getToolResults"),
        "tasks_create" => Some("runtime.tasks.create"),
        "tasks_list" => Some("runtime.tasks.list"),
        "tasks_get" => Some("runtime.tasks.get"),
        "tasks_resume" => Some("runtime.tasks.resume"),
        "tasks_cancel" => Some("runtime.tasks.cancel"),
        _ => None,
    };
    match translated_action {
        Some(translated) => app_cli_action_call(
            translated,
            arguments.clone(),
            Some("redbox_runtime_control"),
            Some(action),
        ),
        None => app_cli_legacy_command_call(
            &legacy_runtime_command(action),
            arguments.clone(),
            Some("redbox_runtime_control"),
            Some(action),
        ),
    }
}

fn app_cli_action_or_legacy_call(
    legacy_tool_name: &'static str,
    operation: &str,
    payload: Value,
) -> NormalizedToolCall {
    match operation {
        "memory.search" => app_cli_action_call(
            "memory.search",
            payload,
            Some(legacy_tool_name),
            Some(operation),
        ),
        "redclaw.profile.bundle" => app_cli_action_call(
            "redclaw.profile.bundle",
            payload,
            Some(legacy_tool_name),
            Some(operation),
        ),
        _ => {
            let command = match operation {
                "spaces.list" => "spaces list",
                "advisors.list" => "advisors list",
                "knowledge.search" => "knowledge search",
                "work.list" => "work list",
                "chat.sessions.list" => "chat sessions list",
                "settings.summary" => "settings summary",
                "redclaw.projects.list" => "redclaw projects",
                "redclaw.profile.onboarding" => "redclaw profile-onboarding",
                _ => "help",
            };
            app_cli_legacy_command_call(command, payload, Some(legacy_tool_name), Some(operation))
        }
    }
}

fn app_cli_action_call(
    action: &str,
    payload: Value,
    legacy_tool_name: Option<&str>,
    legacy_command: Option<&str>,
) -> NormalizedToolCall {
    let mut arguments = Map::new();
    arguments.insert("action".to_string(), json!(action));
    if payload.is_object() {
        arguments.insert("payload".to_string(), payload);
    }
    if let Some(metadata) = compat_metadata_value(legacy_tool_name, legacy_command, Some(action)) {
        arguments.insert("__compat".to_string(), metadata);
    }
    NormalizedToolCall {
        name: "app_cli",
        arguments: Value::Object(arguments),
    }
}

fn app_cli_legacy_command_call(
    command: &str,
    payload: Value,
    legacy_tool_name: Option<&str>,
    legacy_command: Option<&str>,
) -> NormalizedToolCall {
    let mut arguments = Map::new();
    arguments.insert("command".to_string(), json!(command));
    if payload.is_object() {
        arguments.insert("payload".to_string(), payload);
    }
    if let Some(metadata) = compat_metadata_value(legacy_tool_name, legacy_command, None) {
        arguments.insert("__compat".to_string(), metadata);
    }
    NormalizedToolCall {
        name: "app_cli",
        arguments: Value::Object(arguments),
    }
}

fn translate_legacy_app_cli_command(command: &str, payload: &Value) -> NormalizedToolCall {
    let tokens = shell_words::split(command).unwrap_or_else(|_| {
        command
            .split_whitespace()
            .map(ToString::to_string)
            .collect::<Vec<_>>()
    });
    let mut translated_payload = payload.as_object().cloned().unwrap_or_default();
    let translated_action = match tokens
        .iter()
        .map(|item| item.as_str())
        .collect::<Vec<_>>()
        .as_slice()
    {
        ["memory", "list", ..] => Some("memory.list"),
        ["memory", "search", ..] => {
            if let Some(query) = extract_flag_value(&tokens, &["--query", "-q"]) {
                translated_payload.insert("query".to_string(), json!(query));
            }
            Some("memory.search")
        }
        ["memory", "add", rest @ ..] => {
            if !translated_payload.contains_key("content") && !rest.is_empty() {
                translated_payload.insert("content".to_string(), json!(rest.join(" ")));
            }
            Some("memory.add")
        }
        ["redclaw", "profile-bundle", ..] => Some("redclaw.profile.bundle"),
        ["redclaw", "profile-read", ..] => {
            if let Some(doc_type) = extract_flag_value(&tokens, &["--doc-type"]) {
                translated_payload.insert("docType".to_string(), json!(doc_type));
            }
            Some("redclaw.profile.read")
        }
        ["redclaw", "profile-update", ..] => Some("redclaw.profile.update"),
        ["redclaw", "runner-status", ..] => Some("redclaw.runner.status"),
        ["redclaw", "runner-start", ..] => Some("redclaw.runner.start"),
        ["redclaw", "runner-stop", ..] => Some("redclaw.runner.stop"),
        ["redclaw", "runner-set-config", ..] => Some("redclaw.runner.setConfig"),
        ["manuscripts", "list", ..] => Some("manuscripts.list"),
        ["manuscripts", "create-project", ..] => {
            if let Some(kind) = extract_flag_value(&tokens, &["--kind"]) {
                translated_payload.insert("kind".to_string(), json!(kind));
            }
            if let Some(parent) = extract_flag_value(&tokens, &["--parent"]) {
                translated_payload.insert("parent".to_string(), json!(parent));
            }
            if let Some(title) = extract_flag_value(&tokens, &["--title"]) {
                translated_payload.insert("title".to_string(), json!(title));
            }
            Some("manuscripts.createProject")
        }
        ["manuscripts", "write-current", ..] => Some("manuscripts.writeCurrent"),
        ["subjects", "search", ..] => {
            if let Some(query) = extract_flag_value(&tokens, &["--query", "-q"]) {
                translated_payload.insert("query".to_string(), json!(query));
            }
            Some("subjects.search")
        }
        ["subjects", "get", ..] => {
            if let Some(id) = extract_flag_value(&tokens, &["--id"]) {
                translated_payload.insert("id".to_string(), json!(id));
            }
            Some("subjects.get")
        }
        ["runtime", "query", ..] => Some("runtime.query"),
        ["runtime", "get-checkpoints", ..] => Some("runtime.getCheckpoints"),
        ["runtime", "get-tool-results", ..] => Some("runtime.getToolResults"),
        ["runtime", "tasks", "create", ..] => Some("runtime.tasks.create"),
        ["runtime", "tasks", "list", ..] => Some("runtime.tasks.list"),
        ["runtime", "tasks", "get", ..] => Some("runtime.tasks.get"),
        ["runtime", "tasks", "resume", ..] => Some("runtime.tasks.resume"),
        ["runtime", "tasks", "cancel", ..] => Some("runtime.tasks.cancel"),
        ["mcp", "list", ..] => Some("mcp.list"),
        ["mcp", "call", ..] => Some("mcp.call"),
        ["mcp", "list-tools", ..] => Some("mcp.listTools"),
        ["mcp", "list-resources", ..] => Some("mcp.listResources"),
        ["mcp", "disconnect", ..] => Some("mcp.disconnect"),
        ["skills", "list", ..] => Some("skills.list"),
        ["skills", "invoke", ..] => {
            if let Some(name) = extract_flag_value(&tokens, &["--name"]) {
                translated_payload.insert("name".to_string(), json!(name));
            }
            Some("skills.invoke")
        }
        ["image", "generate", ..] => Some("image.generate"),
        ["video", "generate", ..] => Some("video.generate"),
        _ => None,
    };
    match translated_action {
        Some(action) => app_cli_action_call(
            action,
            Value::Object(translated_payload),
            Some("app_cli"),
            Some(command),
        ),
        None => {
            app_cli_legacy_command_call(command, payload.clone(), Some("app_cli"), Some(command))
        }
    }
}

fn extract_flag_value(tokens: &[String], names: &[&str]) -> Option<String> {
    for (index, token) in tokens.iter().enumerate() {
        if names.iter().any(|name| *name == token) {
            return tokens.get(index + 1).cloned();
        }
        for name in names {
            let prefix = format!("{name}=");
            if let Some(value) = token.strip_prefix(&prefix) {
                return Some(value.to_string());
            }
        }
    }
    None
}

fn legacy_skill_command(action: &str) -> String {
    match action {
        "market_install" => "skills market-install".to_string(),
        "ai_roles_list" => "ai roles-list".to_string(),
        "detect_protocol" => "ai detect-protocol".to_string(),
        "test_connection" => "ai test-connection".to_string(),
        "fetch_models" => "ai fetch-models".to_string(),
        other => format!("skills {}", other.replace('_', "-")),
    }
}

fn legacy_runtime_command(action: &str) -> String {
    match action {
        "runtime_resume" => "runtime resume".to_string(),
        "runtime_fork_session" => "runtime fork-session".to_string(),
        "runtime_get_trace" => "runtime get-trace".to_string(),
        "background_tasks_list" => "runtime background list".to_string(),
        "background_tasks_get" => "runtime background get".to_string(),
        "background_tasks_cancel" => "runtime background cancel".to_string(),
        "session_enter_diagnostics" => "runtime session-enter-diagnostics".to_string(),
        "session_bridge_status" => "runtime session-bridge status".to_string(),
        "session_bridge_list_sessions" => "runtime session-bridge list-sessions".to_string(),
        "session_bridge_get_session" => "runtime session-bridge get-session".to_string(),
        other => format!("runtime {}", other.replace('_', "-")),
    }
}

fn copy_if_present(target: &mut Map<String, Value>, source: &Value, key: &str) {
    if let Some(value) = source.get(key) {
        target.insert(key.to_string(), value.clone());
    }
}

fn flatten_payload_fields(source: &Map<String, Value>) -> Map<String, Value> {
    let mut flattened = source.clone();
    if let Some(payload) = source.get("payload").and_then(Value::as_object) {
        for (key, value) in payload {
            if flattened.contains_key(key) {
                continue;
            }
            flattened.insert(key.to_string(), value.clone());
        }
    }
    flattened
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
            normalized.arguments.get("action"),
            Some(&json!("runtime.tasks.list"))
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
            normalized.arguments.get("action"),
            Some(&json!("redclaw.profile.read"))
        );
        assert_eq!(
            normalized
                .arguments
                .get("payload")
                .and_then(|value| value.get("docType")),
            Some(&json!("user"))
        );
        assert!(normalized.arguments.get("__compat").is_some());
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

    #[test]
    fn translates_legacy_app_cli_command_into_structured_action() {
        let normalized = normalize_tool_call(
            "app_cli",
            &json!({ "command": "memory search --query creator" }),
        );

        assert_eq!(
            normalized.arguments.get("action"),
            Some(&json!("memory.search"))
        );
        assert_eq!(
            normalized
                .arguments
                .get("payload")
                .and_then(|value| value.get("query")),
            Some(&json!("creator"))
        );
        assert_eq!(
            normalized
                .arguments
                .get("__compat")
                .and_then(|value| value.get("legacyCommand")),
            Some(&json!("memory search --query creator"))
        );
    }

    #[test]
    fn normalizes_editor_legacy_action_names() {
        let normalized = normalize_tool_call("redbox_editor", &json!({ "action": "project-read" }));
        assert_eq!(
            normalized.arguments.get("action"),
            Some(&json!("project_read"))
        );
        assert!(normalized.arguments.get("__compat").is_some());
    }

    #[test]
    fn flattens_editor_payload_fields_for_structured_schema_calls() {
        let normalized = normalize_tool_call(
            "redbox_editor",
            &json!({
                "action": "script_update",
                "payload": { "content": "updated script" }
            }),
        );
        assert_eq!(
            normalized.arguments.get("content"),
            Some(&json!("updated script"))
        );
    }

    #[test]
    fn normalizes_redbox_fs_legacy_scope_action_pairs() {
        let normalized = normalize_tool_call(
            "redbox_fs",
            &json!({ "scope": "knowledge", "action": "read", "path": "notes/demo.md" }),
        );
        assert_eq!(
            normalized.arguments.get("action"),
            Some(&json!("knowledge.read"))
        );
        assert_eq!(
            normalized.arguments.get("path"),
            Some(&json!("notes/demo.md"))
        );
        assert!(normalized.arguments.get("__compat").is_some());
    }

    #[test]
    fn flattens_redbox_fs_payload_fields_for_structured_schema_calls() {
        let normalized = normalize_tool_call(
            "redbox_fs",
            &json!({
                "action": "workspace.search",
                "payload": { "query": "creator", "path": "docs" }
            }),
        );
        assert_eq!(normalized.arguments.get("query"), Some(&json!("creator")));
        assert_eq!(normalized.arguments.get("path"), Some(&json!("docs")));
    }
}
