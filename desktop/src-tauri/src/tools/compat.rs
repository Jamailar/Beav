use serde_json::{json, Map, Value};

pub struct NormalizedToolCall {
    pub name: &'static str,
    pub arguments: Value,
}

pub fn is_legacy_tool_alias(name: &str) -> bool {
    matches!(
        name.trim(),
        "Redbox"
            | "app_cli"
            | "query"
            | "redbox_app_query"
            | "profile_doc"
            | "redbox_profile_doc"
            | "mcp"
            | "redbox_mcp"
            | "skill"
            | "redbox_skill"
            | "runtime_control"
            | "redbox_runtime_control"
            | "redbox_list_spaces"
            | "redbox_list_advisors"
            | "redbox_search_knowledge"
            | "redbox_list_work_items"
            | "redbox_search_memory"
            | "redbox_list_chat_sessions"
            | "redbox_get_settings_summary"
            | "redbox_list_redclaw_projects"
            | "redbox_fs"
            | "redbox_list_directory"
            | "redbox_read_path"
            | "knowledge_search"
            | "knowledge_glob"
            | "knowledge_grep"
            | "knowledge_read"
            | "redclaw_update_profile_doc"
            | "redclaw_update_creator_profile"
            | "redbox_editor"
    )
}

pub fn canonical_tool_name(name: &str) -> &str {
    match name.trim() {
        "Read" | "List" | "Search" => "resource",
        "Write" | "Operate" | "Redbox" => "workflow",
        "workflow"
        | "app_cli"
        | "query"
        | "redbox_app_query"
        | "profile_doc"
        | "redbox_profile_doc"
        | "mcp"
        | "redbox_mcp"
        | "skill"
        | "redbox_skill"
        | "runtime_control"
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
        | "redclaw_update_creator_profile" => "workflow",
        "bash" | "Bash" => "shell",
        "resource"
        | "redbox_fs"
        | "redbox_list_directory"
        | "redbox_read_path"
        | "knowledge_search"
        | "knowledge_glob"
        | "knowledge_grep"
        | "knowledge_read" => "resource",
        "editor" | "redbox_editor" => "editor",
        other => other,
    }
}

pub fn normalize_tool_call(name: &str, arguments: &Value) -> NormalizedToolCall {
    match name {
        "Read" => normalize_read_call(arguments),
        "List" => normalize_list_call(arguments),
        "Search" => normalize_search_call(arguments),
        "Write" => normalize_write_call(arguments),
        "Operate" | "Redbox" => normalize_redbox_call(arguments),
        "workflow" | "app_cli" => normalize_app_cli_call(arguments),
        "shell" | "bash" | "Bash" => passthrough("shell", arguments),
        "tool_search" => passthrough("tool_search", arguments),
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
        "mcp" | "redbox_mcp" => mcp_to_app_cli(arguments),
        "skill" | "redbox_skill" => skill_to_app_cli(arguments),
        "runtime_control" | "redbox_runtime_control" => runtime_to_app_cli(arguments),
        "query" | "redbox_app_query" => app_query_direct(arguments),
        "resource" | "redbox_fs" => normalize_redbox_fs_call(arguments),
        "profile_doc" | "redbox_profile_doc" => profile_doc_to_app_cli(arguments),
        "editor" | "redbox_editor" => normalize_redbox_editor_call(arguments),
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
            name: "workflow",
            arguments: json!({}),
        };
    };
    if let Some(action) = object.get("action").and_then(Value::as_str) {
        let normalized_action = normalize_action_token(action);
        let mut normalized = object.clone();
        normalized.insert("action".to_string(), json!(normalized_action.clone()));
        if normalized_action != action.trim() {
            if let Some(metadata) =
                compat_metadata_value(Some("workflow"), None, Some(&normalized_action))
            {
                normalized.insert("__compat".to_string(), metadata);
            }
        }
        return NormalizedToolCall {
            name: "workflow",
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
        if let Some(metadata) = compat_metadata_value(Some("workflow"), Some(""), None) {
            normalized.insert("__compat".to_string(), metadata);
        }
        return NormalizedToolCall {
            name: "workflow",
            arguments: Value::Object(normalized),
        };
    }
    translate_legacy_app_cli_command(command, &payload)
}

fn normalize_redbox_editor_call(arguments: &Value) -> NormalizedToolCall {
    let Some(object) = arguments.as_object() else {
        return passthrough("editor", arguments);
    };
    let mut normalized = flatten_payload_fields(object);
    let Some(action) = normalized
        .get("action")
        .and_then(Value::as_str)
        .map(ToString::to_string)
    else {
        return NormalizedToolCall {
            name: "editor",
            arguments: Value::Object(normalized),
        };
    };
    let normalized_action = normalize_action_token(&action);
    normalized.insert("action".to_string(), json!(normalized_action.clone()));
    if normalized_action != action.trim() {
        if let Some(metadata) =
            compat_metadata_value(Some("editor"), Some(&action), Some(&normalized_action))
        {
            normalized.insert("__compat".to_string(), metadata);
        }
    }
    NormalizedToolCall {
        name: "editor",
        arguments: Value::Object(normalized),
    }
}

fn normalize_redbox_fs_call(arguments: &Value) -> NormalizedToolCall {
    let Some(object) = arguments.as_object() else {
        return passthrough("resource", arguments);
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
            compat_metadata_value(Some("resource"), Some(&action), Some(&canonical_action))
        {
            normalized.insert("__compat".to_string(), metadata);
        }
    }
    NormalizedToolCall {
        name: "resource",
        arguments: Value::Object(normalized),
    }
}

fn normalize_read_call(arguments: &Value) -> NormalizedToolCall {
    let object = normalized_universal_arguments(arguments);
    let path = object
        .get("path")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let (scheme, resource_path) = split_virtual_path(path);
    match scheme.as_str() {
        "http" | "https" => {
            let mut payload = Map::new();
            payload.insert("url".to_string(), json!(path));
            copy_universal_as(&mut payload, &object, "limit", "maxChars");
            copy_universal_as(&mut payload, &object, "maxChars", "maxChars");
            copy_universal_as(&mut payload, &object, "includeLinks", "includeLinks");
            app_cli_action_call(
                "web.fetch",
                Value::Object(payload),
                Some("Read"),
                Some(path),
            )
        }
        "web" => {
            let mut payload = Map::new();
            payload.insert("url".to_string(), json!(web_resource_url(&resource_path)));
            copy_universal_as(&mut payload, &object, "limit", "maxChars");
            copy_universal_as(&mut payload, &object, "maxChars", "maxChars");
            copy_universal_as(&mut payload, &object, "includeLinks", "includeLinks");
            app_cli_action_call(
                "web.fetch",
                Value::Object(payload),
                Some("Read"),
                Some(path),
            )
        }
        "editor" => {
            let action = match editor_resource_name(&resource_path).as_str() {
                "project" => "project_read",
                _ => "script_read",
            };
            universal_editor_call(action, &object, Some("Read"), Some(path))
        }
        "profiles" | "profile" => {
            if resource_path.trim().is_empty() || resource_path == "bundle" {
                app_cli_action_call(
                    "redclaw.profile.bundle",
                    json!({}),
                    Some("Read"),
                    Some(path),
                )
            } else {
                app_cli_action_call(
                    "redclaw.profile.read",
                    json!({ "docType": profile_doc_type(&resource_path) }),
                    Some("Read"),
                    Some(path),
                )
            }
        }
        "redclaw" if resource_path.trim_matches('/').starts_with("profile") => {
            let profile_path = resource_path
                .trim_matches('/')
                .strip_prefix("profile")
                .unwrap_or_default()
                .trim_start_matches('/');
            if profile_path.is_empty() || profile_path == "bundle" {
                app_cli_action_call(
                    "redclaw.profile.bundle",
                    json!({}),
                    Some("Read"),
                    Some(path),
                )
            } else {
                app_cli_action_call(
                    "redclaw.profile.read",
                    json!({ "docType": profile_doc_type(profile_path) }),
                    Some("Read"),
                    Some(path),
                )
            }
        }
        "knowledge" => universal_fs_call("knowledge.read", resource_path, &object, Some("Read")),
        "manuscripts" if resource_path == "current" => app_cli_action_call(
            "manuscripts.readCurrent",
            json!({}),
            Some("Read"),
            Some(path),
        ),
        "manuscripts" => app_cli_action_call(
            "manuscripts.read",
            json!({ "path": resource_path }),
            Some("Read"),
            Some(path),
        ),
        "assets" | "asset" if !resource_path.trim_matches('/').is_empty() => app_cli_action_call(
            "assets.get",
            json!({ "id": asset_id_from_resource_path(&resource_path) }),
            Some("Read"),
            Some(path),
        ),
        "subjects" | "subject" if !resource_path.trim_matches('/').is_empty() => {
            app_cli_action_call(
                "assets.get",
                json!({ "id": asset_id_from_resource_path(&resource_path) }),
                Some("Read"),
                Some(path),
            )
        }
        _ => universal_fs_call("workspace.read", resource_path, &object, Some("Read")),
    }
}

fn normalize_list_call(arguments: &Value) -> NormalizedToolCall {
    let object = normalized_universal_arguments(arguments);
    let path = object
        .get("path")
        .and_then(Value::as_str)
        .unwrap_or("workspace://");
    let (scheme, resource_path) = split_virtual_path(path);
    match scheme.as_str() {
        "knowledge" => universal_fs_call("knowledge.list", resource_path, &object, Some("List")),
        "manuscripts" => {
            app_cli_action_call("manuscripts.list", json!({}), Some("List"), Some(path))
        }
        "assets" | "asset" | "subjects" | "subject"
            if !resource_path.trim_matches('/').is_empty() =>
        {
            app_cli_action_call(
                "assets.get",
                json!({ "id": asset_id_from_resource_path(&resource_path) }),
                Some("List"),
                Some(path),
            )
        }
        "assets" | "asset" | "subjects" | "subject" => app_cli_action_call(
            "assets.search",
            json!({ "query": "" }),
            Some("List"),
            Some(path),
        ),
        "profiles" | "profile" => app_cli_action_call(
            "redclaw.profile.bundle",
            json!({}),
            Some("List"),
            Some(path),
        ),
        "redclaw" if resource_path.trim_matches('/').starts_with("profile") => app_cli_action_call(
            "redclaw.profile.bundle",
            json!({}),
            Some("List"),
            Some(path),
        ),
        "memory" => app_cli_action_call("memory.list", json!({}), Some("List"), Some(path)),
        _ => universal_fs_call("workspace.list", resource_path, &object, Some("List")),
    }
}

fn normalize_search_call(arguments: &Value) -> NormalizedToolCall {
    let object = normalized_universal_arguments(arguments);
    let path = object
        .get("path")
        .and_then(Value::as_str)
        .unwrap_or("workspace://");
    let (scheme, resource_path) = split_virtual_path(path);
    match scheme.as_str() {
        "knowledge" => {
            universal_fs_call("knowledge.search", resource_path, &object, Some("Search"))
        }
        "assets" | "asset" | "subjects" | "subject" => {
            let mut payload = Map::new();
            copy_universal(&mut payload, &object, "query");
            copy_universal_as(&mut payload, &object, "limit", "limit");
            app_cli_action_call(
                "assets.search",
                Value::Object(payload),
                Some("Search"),
                Some(path),
            )
        }
        "memory" => {
            let mut payload = Map::new();
            copy_universal(&mut payload, &object, "query");
            app_cli_action_call(
                "memory.search",
                Value::Object(payload),
                Some("Search"),
                Some(path),
            )
        }
        "web" => app_cli_legacy_command_call(
            "help",
            json!({ "resource": "web", "operation": "search", "input": Value::Object(object.clone()) }),
            Some("Search"),
            Some(path),
        ),
        _ => universal_fs_call("workspace.search", resource_path, &object, Some("Search")),
    }
}

fn normalize_write_call(arguments: &Value) -> NormalizedToolCall {
    let object = normalized_universal_arguments(arguments);
    let path = object
        .get("path")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let content = object.get("content").cloned().unwrap_or_else(|| json!(""));
    let (scheme, resource_path) = split_virtual_path(path);
    match scheme.as_str() {
        "editor" => {
            let mut payload = Map::new();
            payload.insert("content".to_string(), content);
            copy_universal(&mut payload, &object, "source");
            NormalizedToolCall {
                name: "editor",
                arguments: Value::Object(with_action_payload(
                    "script_update",
                    payload,
                    Some("Write"),
                    Some(path),
                )),
            }
        }
        "profiles" | "profile" => app_cli_action_call(
            "redclaw.profile.update",
            json!({
                "docType": profile_doc_type(&resource_path),
                "markdown": content
            }),
            Some("Write"),
            Some(path),
        ),
        "manuscripts" if resource_path.trim().is_empty() || resource_path == "current" => {
            app_cli_action_call(
                "manuscripts.writeCurrent",
                json!({ "content": content }),
                Some("Write"),
                Some(path),
            )
        }
        _ => app_cli_legacy_command_call(
            "help write",
            json!({ "path": path, "content": content }),
            Some("Write"),
            Some(path),
        ),
    }
}

fn normalize_redbox_call(arguments: &Value) -> NormalizedToolCall {
    let object = normalized_universal_arguments(arguments);
    let resource = object
        .get("resource")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    let operation = object
        .get("operation")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    let mut input = object
        .get("input")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    if let Some(id) = object.get("id").cloned() {
        input.entry("id".to_string()).or_insert(id);
    }
    let nested_action = input
        .get("action")
        .or_else(|| object.get("action"))
        .and_then(Value::as_str)
        .map(normalize_action_token);
    if resource == "cli_runtime" {
        if let Some(action) = nested_action.as_deref() {
            if action.starts_with("cli_runtime.") {
                input.remove("action");
                return app_cli_action_call(
                    action,
                    Value::Object(input),
                    Some("Operate"),
                    Some(&format!("cli_runtime.{operation}")),
                );
            }
        }
    }
    let payload = Value::Object(input);
    match (resource.as_str(), operation.as_str()) {
        ("manuscript" | "manuscripts", "list") => app_cli_action_call(
            "manuscripts.list",
            payload,
            Some("Operate"),
            Some("manuscript.list"),
        ),
        ("manuscript" | "manuscripts", "create" | "createproject") => app_cli_action_call(
            "manuscripts.createProject",
            payload,
            Some("Operate"),
            Some("manuscript.create"),
        ),
        ("manuscript" | "manuscripts", "get") => {
            let mut map = payload.as_object().cloned().unwrap_or_default();
            if let Some(id) = map.remove("id") {
                map.entry("path".to_string()).or_insert(id);
            }
            let action = if map.get("path").and_then(Value::as_str) == Some("current") {
                "manuscripts.readCurrent"
            } else {
                "manuscripts.read"
            };
            app_cli_action_call(
                action,
                Value::Object(map),
                Some("Operate"),
                Some("manuscript.get"),
            )
        }
        (
            "manuscript" | "manuscripts",
            "update" | "run" | "write" | "writecurrent" | "write-current",
        ) => app_cli_action_call(
            "manuscripts.writeCurrent",
            payload,
            Some("Operate"),
            Some("manuscript.update"),
        ),
        (
            "profile" | "profiles" | "redclaw.profile" | "redclaw_profiles" | "redclaw-profiles",
            "list" | "get" | "read" | "bundle",
        ) => {
            if payload.get("docType").is_some() || payload.get("id").is_some() {
                let mut map = payload.as_object().cloned().unwrap_or_default();
                if let Some(id) = map.remove("id") {
                    map.entry("docType".to_string()).or_insert(id);
                }
                app_cli_action_call(
                    "redclaw.profile.read",
                    Value::Object(map),
                    Some("Operate"),
                    Some("profile.get"),
                )
            } else {
                app_cli_action_call(
                    "redclaw.profile.bundle",
                    payload,
                    Some("Operate"),
                    Some("profile.list"),
                )
            }
        }
        (
            "profile" | "profiles" | "redclaw.profile" | "redclaw_profiles" | "redclaw-profiles",
            "update",
        ) => app_cli_action_call(
            "redclaw.profile.update",
            payload,
            Some("Operate"),
            Some("profile.update"),
        ),
        (
            "profile" | "profiles" | "redclaw.profile" | "redclaw_profiles" | "redclaw-profiles",
            "complete" | "complete-style-definition" | "completestyledefinition",
        ) => app_cli_action_call(
            "redclaw.profile.completeStyleDefinition",
            payload,
            Some("Operate"),
            Some("profile.completeStyleDefinition"),
        ),
        ("memory", "list") => {
            app_cli_action_call("memory.list", payload, Some("Operate"), Some("memory.list"))
        }
        ("memory", "search" | "get") => app_cli_action_call(
            "memory.search",
            payload,
            Some("Operate"),
            Some("memory.search"),
        ),
        ("session" | "session.resources" | "session_resources", "list" | "search") => {
            app_cli_action_call(
                "session.resources.list",
                payload,
                Some("Operate"),
                Some("session.resources.list"),
            )
        }
        ("session" | "session.resources" | "session_resources", "get" | "read") => {
            app_cli_action_call(
                "session.resources.get",
                payload,
                Some("Operate"),
                Some("session.resources.get"),
            )
        }
        ("memory", "create" | "update") => {
            app_cli_action_call("memory.add", payload, Some("Operate"), Some("memory.add"))
        }
        ("web", "get" | "read" | "fetch") => {
            let mut map = payload.as_object().cloned().unwrap_or_default();
            if let Some(id) = map.remove("id") {
                map.entry("url".to_string()).or_insert(id);
            }
            app_cli_action_call(
                "web.fetch",
                Value::Object(map),
                Some("Operate"),
                Some("web.fetch"),
            )
        }
        ("asset" | "assets" | "subject" | "subjects", "search" | "list") => app_cli_action_call(
            "assets.search",
            payload,
            Some("Operate"),
            Some("assets.search"),
        ),
        ("asset" | "assets" | "subject" | "subjects", "get") => {
            let payload = normalize_id_payload(payload, "id");
            app_cli_action_call("assets.get", payload, Some("Operate"), Some("assets.get"))
        }
        ("asset" | "assets" | "subject" | "subjects", "create" | "add") => app_cli_action_call(
            "assets.create",
            payload,
            Some("Operate"),
            Some("assets.create"),
        ),
        ("asset" | "assets" | "subject" | "subjects", "update") => app_cli_action_call(
            "assets.update",
            payload,
            Some("Operate"),
            Some("assets.update"),
        ),
        ("asset" | "assets" | "subject" | "subjects", "delete") => {
            let payload = normalize_id_payload(payload, "id");
            app_cli_action_call(
                "assets.delete",
                payload,
                Some("Operate"),
                Some("assets.delete"),
            )
        }
        ("asset" | "assets" | "subject" | "subjects", "generate" | "run") => app_cli_action_call(
            "assets.generateCharacterCard",
            normalize_id_payload(payload, "id"),
            Some("Operate"),
            Some("assets.generateCharacterCard"),
        ),
        ("image", "generate" | "create" | "run") => app_cli_action_call(
            "image.generate",
            payload,
            Some("Operate"),
            Some("image.generate"),
        ),
        ("generation" | "job" | "jobs", "list" | "search") => app_cli_action_call(
            "generation.job.list",
            payload,
            Some("Operate"),
            Some("generation.job.list"),
        ),
        ("generation" | "job" | "jobs", "get" | "status" | "progress") => {
            let payload = normalize_id_payload(payload, "jobId");
            app_cli_action_call(
                "generation.job.get",
                payload,
                Some("Operate"),
                Some("generation.job.get"),
            )
        }
        ("video", "generate" | "run") => app_cli_action_call(
            "video.generate",
            payload,
            Some("Operate"),
            Some("video.generate"),
        ),
        ("voice", "speech" | "tts" | "run" | "generate") => app_cli_action_call(
            "voice.speech",
            normalize_voice_speech_payload(payload),
            Some("Operate"),
            Some("voice.speech"),
        ),
        ("video", "analyze") => app_cli_action_call(
            "video.analyze",
            payload,
            Some("Operate"),
            Some("video.analyze"),
        ),
        ("skill" | "skills", "list") => {
            app_cli_action_call("skills.list", payload, Some("Operate"), Some("skill.list"))
        }
        ("skill" | "skills", "run" | "invoke" | "create" | "confirm") => {
            let mut map = payload.as_object().cloned().unwrap_or_default();
            if !map.contains_key("name") {
                if let Some(id) = map.get("id").and_then(Value::as_str) {
                    map.insert("name".to_string(), json!(id));
                }
            }
            app_cli_action_call(
                "skills.invoke",
                Value::Object(map),
                Some("Operate"),
                Some("skill.invoke"),
            )
        }
        ("mcp", "list") => {
            app_cli_action_call("mcp.list", payload, Some("Operate"), Some("mcp.list"))
        }
        ("mcp", "get") => app_cli_action_call(
            "mcp.sessions",
            payload,
            Some("Operate"),
            Some("mcp.sessions"),
        ),
        ("mcp", "verify") => {
            app_cli_action_call("mcp.test", payload, Some("Operate"), Some("mcp.test"))
        }
        ("mcp", "install" | "create" | "update") => {
            app_cli_action_call("mcp.save", payload, Some("Operate"), Some("mcp.save"))
        }
        ("mcp", "run" | "call") => {
            app_cli_action_call("mcp.call", payload, Some("Operate"), Some("mcp.call"))
        }
        ("editor", "run" | "update" | "generate" | "export") => {
            normalize_redbox_editor_operation(&operation, payload)
        }
        ("media", "edit" | "cut" | "trim") => {
            app_cli_action_call("media.edit", payload, Some("Operate"), Some("media.edit"))
        }
        ("media", "transcribe" | "subtitle" | "subtitles" | "asr") => app_cli_action_call(
            "media.transcribe",
            payload,
            Some("Operate"),
            Some("media.transcribe"),
        ),
        ("media", "videoretalk" | "video-retalk" | "retalk") => app_cli_action_call(
            "media.videoRetalk",
            payload,
            Some("Operate"),
            Some("media.videoRetalk"),
        ),
        ("runtime", "get" | "list") => app_cli_action_call(
            "runtime.query",
            payload,
            Some("Operate"),
            Some("runtime.query"),
        ),
        ("runtime", "create") => app_cli_action_call(
            "runtime.tasks.create",
            payload,
            Some("Operate"),
            Some("runtime.create"),
        ),
        ("runtime", "resume") => app_cli_action_call(
            "runtime.tasks.resume",
            payload,
            Some("Operate"),
            Some("runtime.resume"),
        ),
        ("runtime", "cancel") => app_cli_action_call(
            "runtime.tasks.cancel",
            payload,
            Some("Operate"),
            Some("runtime.cancel"),
        ),
        ("team.guide" | "team_guide" | "team-guide", "create") => app_cli_action_call(
            "team.guide.create",
            payload,
            Some("Operate"),
            Some("team.guide.create"),
        ),
        ("team.session" | "team_session" | "team-session", "create") => app_cli_action_call(
            "team.session.create",
            payload,
            Some("Operate"),
            Some("team.session.create"),
        ),
        ("team.session" | "team_session" | "team-session", "list") => app_cli_action_call(
            "team.session.list",
            payload,
            Some("Operate"),
            Some("team.session.list"),
        ),
        ("team.session" | "team_session" | "team-session", "get") => app_cli_action_call(
            "team.session.get",
            payload,
            Some("Operate"),
            Some("team.session.get"),
        ),
        ("team.member" | "team_member" | "team-member", "spawn" | "create" | "add") => {
            app_cli_action_call(
                "team.member.spawn",
                payload,
                Some("Operate"),
                Some("team.member.spawn"),
            )
        }
        ("team.member" | "team_member" | "team-member", "match") => app_cli_action_call(
            "team.member.match",
            payload,
            Some("Operate"),
            Some("team.member.match"),
        ),
        ("team.member" | "team_member" | "team-member", "rename") => app_cli_action_call(
            "team.member.rename",
            payload,
            Some("Operate"),
            Some("team.member.rename"),
        ),
        ("team.member" | "team_member" | "team-member", "shutdown") => app_cli_action_call(
            "team.member.shutdown",
            payload,
            Some("Operate"),
            Some("team.member.shutdown"),
        ),
        ("team.member" | "team_member" | "team-member", "list") => app_cli_action_call(
            "team.members.list",
            payload,
            Some("Operate"),
            Some("team.member.list"),
        ),
        ("team.task" | "team_task" | "team-task", "create") => app_cli_action_call(
            "team.task.create",
            payload,
            Some("Operate"),
            Some("team.task.create"),
        ),
        ("team.task" | "team_task" | "team-task", "update") => app_cli_action_call(
            "team.task.update",
            payload,
            Some("Operate"),
            Some("team.task.update"),
        ),
        ("team.task" | "team_task" | "team-task", "list") => app_cli_action_call(
            "team.task.list",
            payload,
            Some("Operate"),
            Some("team.task.list"),
        ),
        ("team.message" | "team_message" | "team-message", "send") => app_cli_action_call(
            "team.message.send",
            payload,
            Some("Operate"),
            Some("team.message.send"),
        ),
        ("team.report" | "team_report" | "team-report", "request") => app_cli_action_call(
            "team.report.request",
            payload,
            Some("Operate"),
            Some("team.report.request"),
        ),
        ("team.report" | "team_report" | "team-report", "submit") => app_cli_action_call(
            "team.report.submit",
            payload,
            Some("Operate"),
            Some("team.report.submit"),
        ),
        ("team.report" | "team_report" | "team-report", "list") => app_cli_action_call(
            "team.report.list",
            payload,
            Some("Operate"),
            Some("team.report.list"),
        ),
        ("team.artifact" | "team_artifact" | "team-artifact", "attach") => app_cli_action_call(
            "team.artifact.attach",
            payload,
            Some("Operate"),
            Some("team.artifact.attach"),
        ),
        ("cli_runtime", "list") => app_cli_action_call(
            "cli_runtime.environment.list",
            payload,
            Some("Operate"),
            Some("cli_runtime.list"),
        ),
        ("cli_runtime", "detect") => app_cli_action_call(
            "cli_runtime.detect",
            payload,
            Some("Operate"),
            Some("cli_runtime.detect"),
        ),
        ("cli_runtime", "discover" | "search") => app_cli_action_call(
            "cli_runtime.discover",
            payload,
            Some("Operate"),
            Some("cli_runtime.discover"),
        ),
        ("cli_runtime", "inspect") => app_cli_action_call(
            "cli_runtime.inspect",
            payload,
            Some("Operate"),
            Some("cli_runtime.inspect"),
        ),
        ("cli_runtime", "get" | "poll" | "snapshot") => {
            let execution_id = payload
                .get("executionId")
                .or_else(|| payload.get("execution_id"))
                .or_else(|| payload.get("id"))
                .and_then(Value::as_str)
                .unwrap_or_default();
            if execution_id.starts_with("cli-exec-") {
                app_cli_action_call(
                    "cli_runtime.execution.get",
                    payload,
                    Some("Operate"),
                    Some("cli_runtime.get"),
                )
            } else {
                app_cli_action_call(
                    "cli_runtime.inspect",
                    payload,
                    Some("Operate"),
                    Some("cli_runtime.get"),
                )
            }
        }
        ("cli_runtime", "diagnose") => app_cli_action_call(
            "cli_runtime.diagnose",
            payload,
            Some("Operate"),
            Some("cli_runtime.diagnose"),
        ),
        ("cli_runtime", "install") => app_cli_action_call(
            "cli_runtime.install",
            payload,
            Some("Operate"),
            Some("cli_runtime.install"),
        ),
        ("cli_runtime", "run") => app_cli_action_call(
            "cli_runtime.execute",
            payload,
            Some("Operate"),
            Some("cli_runtime.run"),
        ),
        ("cli_runtime", "verify") => {
            if payload.get("executionId").is_some() || payload.get("execution_id").is_some() {
                app_cli_action_call(
                    "cli_runtime.verify",
                    payload,
                    Some("Operate"),
                    Some("cli_runtime.verify"),
                )
            } else {
                app_cli_action_call(
                    "cli_runtime.diagnose",
                    payload,
                    Some("Operate"),
                    Some("cli_runtime.verify"),
                )
            }
        }
        _ => app_cli_legacy_command_call(
            "help",
            json!({ "resource": resource, "operation": operation, "input": payload }),
            Some("Operate"),
            Some("unknown"),
        ),
    }
}

fn normalize_voice_speech_payload(payload: Value) -> Value {
    let mut payload = payload.as_object().cloned().unwrap_or_default();

    if let Some(raw_nested_input_payload) = payload.remove("input") {
        if let Value::Object(nested_voice_payload) = raw_nested_input_payload {
            if !payload.contains_key("input") {
                if let Some(input) = nested_voice_payload
                    .get("input")
                    .or_else(|| nested_voice_payload.get("text"))
                    .or_else(|| nested_voice_payload.get("script"))
                {
                    payload.insert("input".to_string(), input.clone());
                }
            }
            if !payload.contains_key("voiceId") && !payload.contains_key("voice_id") {
                if let Some(voice_id) = nested_voice_payload
                    .get("voiceId")
                    .or_else(|| nested_voice_payload.get("voice_id"))
                    .or_else(|| nested_voice_payload.get("voice"))
                    .or_else(|| nested_voice_payload.get("voiceRef"))
                    .or_else(|| nested_voice_payload.get("voice_ref"))
                    .or_else(|| nested_voice_payload.get("id"))
                {
                    payload.insert("voiceId".to_string(), voice_id.clone());
                }
            }
        } else {
            payload.insert("input".to_string(), raw_nested_input_payload);
        }
    }

    if !payload.contains_key("input") {
        if let Some(text) = payload.remove("text").or_else(|| payload.remove("script")) {
            payload.insert("input".to_string(), text);
        }
    }
    if !payload.contains_key("voiceId") && !payload.contains_key("voice_id") {
        if let Some(voice) = payload
            .remove("voice")
            .or_else(|| payload.remove("voiceRef"))
            .or_else(|| payload.remove("voice_ref"))
            .or_else(|| payload.remove("id"))
        {
            payload.insert("voiceId".to_string(), voice);
        }
    }
    payload
        .entry("waitForCompletion".to_string())
        .or_insert(json!(true));
    Value::Object(payload)
}

fn normalize_redbox_editor_operation(operation: &str, payload: Value) -> NormalizedToolCall {
    let workflow = payload
        .get("workflow")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .replace('-', "_");
    let action = match (operation, workflow.as_str()) {
        ("export", _) => "export",
        (_, "ffmpeg.edit" | "ffmpeg_edit") => "ffmpeg_edit",
        (_, "script.update" | "script_update") => "script_update",
        (_, "script.confirm" | "script_confirm") => "script_confirm",
        (_, "project.read" | "project_read") => "project_read",
        _ => "project_read",
    };
    let payload = payload.as_object().cloned().unwrap_or_default();
    NormalizedToolCall {
        name: "editor",
        arguments: Value::Object(with_action_payload(
            action,
            payload,
            Some("Operate"),
            Some("editor.run"),
        )),
    }
}

fn normalized_universal_arguments(arguments: &Value) -> Map<String, Value> {
    arguments
        .as_object()
        .map(flatten_payload_fields)
        .unwrap_or_default()
}

fn split_virtual_path(path: &str) -> (String, String) {
    let trimmed = path.trim();
    if let Some((scheme, rest)) = trimmed.split_once("://") {
        return (
            scheme.trim().to_ascii_lowercase(),
            rest.trim_start_matches('/').to_string(),
        );
    }
    ("workspace".to_string(), trimmed.to_string())
}

fn asset_id_from_resource_path(resource_path: &str) -> &str {
    resource_path
        .trim_matches('/')
        .split('/')
        .next()
        .unwrap_or_default()
}

fn web_resource_url(resource_path: &str) -> String {
    let trimmed = resource_path.trim();
    if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        trimmed.to_string()
    } else {
        format!("https://{}", trimmed.trim_start_matches('/'))
    }
}

fn editor_resource_name(path: &str) -> String {
    let normalized = path.trim_matches('/').to_ascii_lowercase();
    let without_current = normalized.strip_prefix("current/").unwrap_or(&normalized);
    without_current
        .split('/')
        .next()
        .unwrap_or("script")
        .replace('-', "_")
}

fn profile_doc_type(path: &str) -> String {
    let normalized = path
        .trim_matches('/')
        .trim_end_matches(".md")
        .trim_end_matches(".markdown")
        .to_ascii_lowercase();
    match normalized.as_str() {
        "creator" | "creator-profile" | "creator_profile" | "creatorprofile" => {
            "creator_profile".to_string()
        }
        "soul" => "soul".to_string(),
        "agent" => "agent".to_string(),
        _ => "user".to_string(),
    }
}

fn universal_fs_call(
    action: &'static str,
    resource_path: String,
    source: &Map<String, Value>,
    legacy_tool_name: Option<&str>,
) -> NormalizedToolCall {
    let mut payload = Map::new();
    payload.insert("action".to_string(), json!(action));
    if action.starts_with("knowledge.") {
        payload.insert("scope".to_string(), json!("knowledge"));
    }
    if !resource_path.trim().is_empty() {
        payload.insert("path".to_string(), json!(resource_path));
    }
    for key in [
        "query",
        "pattern",
        "glob",
        "advisorId",
        "sourceId",
        "rootPath",
        "blockId",
        "anchorId",
        "offset",
        "limit",
        "maxChars",
        "snippetChars",
    ] {
        copy_universal(&mut payload, source, key);
    }
    if let Some(value) = payload.remove("glob") {
        payload.entry("pattern".to_string()).or_insert(value);
    }
    if let Some(metadata) = compat_metadata_value(legacy_tool_name, None, Some(action)) {
        payload.insert("__compat".to_string(), metadata);
    }
    NormalizedToolCall {
        name: "resource",
        arguments: Value::Object(payload),
    }
}

fn universal_editor_call(
    action: &'static str,
    source: &Map<String, Value>,
    legacy_tool_name: Option<&str>,
    legacy_command: Option<&str>,
) -> NormalizedToolCall {
    let mut payload = Map::new();
    for key in ["filePath", "offset", "limit", "maxChars"] {
        copy_universal(&mut payload, source, key);
    }
    NormalizedToolCall {
        name: "editor",
        arguments: Value::Object(with_action_payload(
            action,
            payload,
            legacy_tool_name,
            legacy_command,
        )),
    }
}

fn with_action_payload(
    action: &str,
    payload: Map<String, Value>,
    legacy_tool_name: Option<&str>,
    legacy_command: Option<&str>,
) -> Map<String, Value> {
    let mut arguments = Map::new();
    arguments.insert("action".to_string(), json!(action));
    for (key, value) in payload {
        arguments.insert(key, value);
    }
    if let Some(metadata) = compat_metadata_value(legacy_tool_name, legacy_command, Some(action)) {
        arguments.insert("__compat".to_string(), metadata);
    }
    arguments
}

fn normalize_id_payload(payload: Value, id_key: &str) -> Value {
    let mut map = payload.as_object().cloned().unwrap_or_default();
    if let Some(id) = map.remove("id") {
        map.entry(id_key.to_string()).or_insert(id);
    }
    Value::Object(map)
}

fn copy_universal(target: &mut Map<String, Value>, source: &Map<String, Value>, key: &str) {
    if let Some(value) = source.get(key) {
        target.insert(key.to_string(), value.clone());
    }
}

fn copy_universal_as(
    target: &mut Map<String, Value>,
    source: &Map<String, Value>,
    key: &str,
    target_key: &str,
) {
    if let Some(value) = source.get(key) {
        target.insert(target_key.to_string(), value.clone());
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
        "create.directory" | "createdirectory" | "mkdir" => "workspace.createDirectory".to_string(),
        "write" => "workspace.write".to_string(),
        "workspace.create.directory" | "workspace.createdirectory" | "workspace.mkdir" => {
            "workspace.createDirectory".to_string()
        }
        "workspace.list"
        | "workspace.read"
        | "workspace.createDirectory"
        | "workspace.write"
        | "workspace.search"
        | "knowledge.list"
        | "knowledge.read"
        | "knowledge.attach"
        | "knowledge.search" => normalized_action,
        other => other.to_string(),
    };
    match combined.as_str() {
        "workspace.list"
        | "workspace.read"
        | "workspace.createDirectory"
        | "workspace.write"
        | "workspace.search"
        | "knowledge.list"
        | "knowledge.read"
        | "knowledge.attach"
        | "knowledge.search" => combined,
        _ => combined,
    }
}

fn app_query(operation: &'static str, arguments: &Value) -> NormalizedToolCall {
    let mut payload = Map::new();
    copy_if_present(&mut payload, arguments, "query");
    copy_if_present(&mut payload, arguments, "status");
    copy_if_present(&mut payload, arguments, "limit");
    app_cli_action_or_legacy_call("query", operation, Value::Object(payload))
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
    app_cli_action_or_legacy_call("query", operation, Value::Object(payload))
}

fn fs_call(action: &'static str, arguments: &Value) -> NormalizedToolCall {
    let mut payload = Map::new();
    payload.insert("action".to_string(), json!(action));
    copy_if_present(&mut payload, arguments, "path");
    copy_if_present(&mut payload, arguments, "limit");
    copy_if_present(&mut payload, arguments, "maxChars");
    NormalizedToolCall {
        name: "resource",
        arguments: Value::Object(payload),
    }
}

fn knowledge_fs_call(action: &'static str, arguments: &Value) -> NormalizedToolCall {
    let mut payload = Map::new();
    payload.insert("scope".to_string(), json!("knowledge"));
    payload.insert("action".to_string(), json!(action));
    copy_if_present(&mut payload, arguments, "advisorId");
    copy_if_present(&mut payload, arguments, "sourceId");
    copy_if_present(&mut payload, arguments, "rootPath");
    copy_if_present(&mut payload, arguments, "path");
    copy_if_present(&mut payload, arguments, "pattern");
    copy_if_present(&mut payload, arguments, "query");
    copy_if_present(&mut payload, arguments, "blockId");
    copy_if_present(&mut payload, arguments, "anchorId");
    copy_if_present(&mut payload, arguments, "offset");
    copy_if_present(&mut payload, arguments, "limit");
    copy_if_present(&mut payload, arguments, "maxChars");
    copy_if_present(&mut payload, arguments, "snippetChars");
    NormalizedToolCall {
        name: "resource",
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
            Some("profile_doc"),
            Some(action),
        ),
        None => app_cli_legacy_command_call(
            "help redclaw",
            Value::Object(payload),
            Some("profile_doc"),
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
        "sessions" => Some("mcp.sessions"),
        "oauth_status" | "oauth-status" => Some("mcp.oauthStatus"),
        "save" => Some("mcp.save"),
        "test" | "probe" => Some("mcp.test"),
        "call" => Some("mcp.call"),
        "list_tools" => Some("mcp.listTools"),
        "list_resources" => Some("mcp.listResources"),
        "list_resource_templates" => Some("mcp.listResourceTemplates"),
        "disconnect" => Some("mcp.disconnect"),
        "disconnect_all" | "disconnect-all" => Some("mcp.disconnectAll"),
        "discover_local" | "discover-local" => Some("mcp.discoverLocal"),
        "import_local" | "import-local" => Some("mcp.importLocal"),
        _ => None,
    };
    match translated_action {
        Some(translated) => {
            app_cli_action_call(translated, arguments.clone(), Some("mcp"), Some(action))
        }
        None => app_cli_legacy_command_call(
            &format!("mcp {}", action.replace('_', "-")),
            arguments.clone(),
            Some("mcp"),
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
        Some(translated) => {
            app_cli_action_call(translated, arguments.clone(), Some("skill"), Some(action))
        }
        None => app_cli_legacy_command_call(
            &legacy_skill_command(action),
            arguments.clone(),
            Some("skill"),
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
            Some("runtime_control"),
            Some(action),
        ),
        None => app_cli_legacy_command_call(
            &legacy_runtime_command(action),
            arguments.clone(),
            Some("runtime_control"),
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
        "redclaw.profile.completeStyleDefinition" => app_cli_action_call(
            "redclaw.profile.completeStyleDefinition",
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
        name: "workflow",
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
        name: "workflow",
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
        ["memory", "recall", ..] => {
            if let Some(query) = extract_flag_value(&tokens, &["--query", "-q"]) {
                translated_payload.insert("query".to_string(), json!(query));
            }
            Some("memory.recall")
        }
        ["memory", "add", rest @ ..] => {
            if !translated_payload.contains_key("content") && !rest.is_empty() {
                translated_payload.insert("content".to_string(), json!(rest.join(" ")));
            }
            Some("memory.add")
        }
        ["memory", "update", ..] => Some("memory.update"),
        ["memory", "archive", ..] => Some("memory.archive"),
        ["memory", "rebuild-index", ..] => Some("memory.rebuildIndex"),
        ["memory", "diagnostics", ..] => Some("memory.diagnostics"),
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
        ["assets", "search", ..] | ["subjects", "search", ..] => {
            if let Some(query) = extract_flag_value(&tokens, &["--query", "-q"]) {
                translated_payload.insert("query".to_string(), json!(query));
            }
            Some("assets.search")
        }
        ["assets", "get", ..] | ["subjects", "get", ..] => {
            if let Some(id) = extract_flag_value(&tokens, &["--id"]) {
                translated_payload.insert("id".to_string(), json!(id));
            }
            Some("assets.get")
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
        ["media", "edit", ..] => Some("media.edit"),
        ["media", "transcribe", ..] => Some("media.transcribe"),
        _ => None,
    };
    match translated_action {
        Some(action) => app_cli_action_call(
            action,
            Value::Object(translated_payload),
            Some("workflow"),
            Some(command),
        ),
        None => {
            app_cli_legacy_command_call(command, payload.clone(), Some("workflow"), Some(command))
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
        let normalized = normalize_tool_call("runtime_control", &json!({ "action": "tasks_list" }));

        assert_eq!(normalized.name, "workflow");
        assert_eq!(
            normalized.arguments.get("action"),
            Some(&json!("runtime.tasks.list"))
        );
    }

    #[test]
    fn passes_tool_search_through() {
        let normalized = normalize_tool_call(
            "tool_search",
            &json!({ "query": "image-director", "includeDirect": true }),
        );

        assert_eq!(normalized.name, "tool_search");
        assert_eq!(
            normalized.arguments.get("query"),
            Some(&json!("image-director"))
        );
    }

    #[test]
    fn normalizes_profile_doc_to_app_cli() {
        let normalized = normalize_tool_call(
            "profile_doc",
            &json!({ "action": "read", "docType": "user" }),
        );

        assert_eq!(normalized.name, "workflow");
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
            "mcp",
            &json!({ "action": "oauth_status", "serverId": "server-1" }),
        );

        assert_eq!(normalized.name, "workflow");
        assert_eq!(
            normalized.arguments.get("action"),
            Some(&json!("mcp.oauthStatus"))
        );
    }

    #[test]
    fn normalizes_asset_get_id_from_operate_and_virtual_paths() {
        let operate = normalize_tool_call(
            "Operate",
            &json!({
                "resource": "asset",
                "operation": "get",
                "id": "subject_1774704234274_53536cc0"
            }),
        );
        assert_eq!(operate.name, "workflow");
        assert_eq!(operate.arguments.get("action"), Some(&json!("assets.get")));
        assert_eq!(
            operate
                .arguments
                .get("payload")
                .and_then(|value| value.get("id")),
            Some(&json!("subject_1774704234274_53536cc0"))
        );

        let read = normalize_tool_call(
            "Read",
            &json!({ "path": "assets://subject_1774704234274_53536cc0/subject.json" }),
        );
        assert_eq!(read.arguments.get("action"), Some(&json!("assets.get")));
        assert_eq!(
            read.arguments
                .get("payload")
                .and_then(|value| value.get("id")),
            Some(&json!("subject_1774704234274_53536cc0"))
        );

        let list = normalize_tool_call(
            "List",
            &json!({ "path": "assets://subject_1774704234274_53536cc0" }),
        );
        assert_eq!(list.arguments.get("action"), Some(&json!("assets.get")));
        assert_eq!(
            list.arguments
                .get("payload")
                .and_then(|value| value.get("id")),
            Some(&json!("subject_1774704234274_53536cc0"))
        );
    }

    #[test]
    fn normalizes_asset_mutation_actions_from_operate() {
        let create = normalize_tool_call(
            "Operate",
            &json!({
                "resource": "asset",
                "operation": "create",
                "input": {
                    "name": "林夕",
                    "kind": "character",
                    "categoryName": "角色"
                }
            }),
        );
        assert_eq!(create.name, "workflow");
        assert_eq!(
            create.arguments.get("action"),
            Some(&json!("assets.create"))
        );
        assert_eq!(
            create
                .arguments
                .get("payload")
                .and_then(|value| value.get("kind")),
            Some(&json!("character"))
        );

        let generate = normalize_tool_call(
            "Operate",
            &json!({
                "resource": "asset",
                "operation": "generate",
                "id": "subject_1774704234274_53536cc0"
            }),
        );
        assert_eq!(
            generate.arguments.get("action"),
            Some(&json!("assets.generateCharacterCard"))
        );
        assert_eq!(
            generate
                .arguments
                .get("payload")
                .and_then(|value| value.get("id")),
            Some(&json!("subject_1774704234274_53536cc0"))
        );
    }

    #[test]
    fn translates_legacy_app_cli_command_into_structured_action() {
        let normalized = normalize_tool_call(
            "workflow",
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
        let normalized = normalize_tool_call("editor", &json!({ "action": "project-read" }));
        assert_eq!(
            normalized.arguments.get("action"),
            Some(&json!("project_read"))
        );
        assert!(normalized.arguments.get("__compat").is_some());
    }

    #[test]
    fn normalizes_operate_voice_speech_to_voice_speech_action() {
        let normalized = normalize_tool_call(
            "Operate",
            &json!({
                "resource": "voice",
                "operation": "speech",
                "input": {
                    "input": "君不见黄河之水天上来。",
                    "voice": "voice_2eee156a6468427bb185a831"
                }
            }),
        );

        assert_eq!(normalized.name, "workflow");
        assert_eq!(
            normalized.arguments.get("action"),
            Some(&json!("voice.speech"))
        );
        assert_eq!(
            normalized
                .arguments
                .get("payload")
                .and_then(|value| value.get("input")),
            Some(&json!("君不见黄河之水天上来。"))
        );
        assert_eq!(
            normalized
                .arguments
                .get("payload")
                .and_then(|value| value.get("voiceId")),
            Some(&json!("voice_2eee156a6468427bb185a831"))
        );
    }

    #[test]
    fn normalizes_voice_speech_payload_aliases_for_compat() {
        let normalized = normalize_tool_call(
            "Operate",
            &json!({
                "resource": "voice",
                "operation": "speech",
                "input": {
                    "text": "君不见黄河之水天上来。",
                    "id": "voice_2eee156a6468427bb185a831"
                }
            }),
        );

        assert_eq!(normalized.name, "workflow");
        let payload = normalized
            .arguments
            .get("payload")
            .and_then(Value::as_object)
            .expect("payload exists");
        assert_eq!(payload.get("input"), Some(&json!("君不见黄河之水天上来。")));
        assert_eq!(
            payload.get("voiceId"),
            Some(&json!("voice_2eee156a6468427bb185a831"))
        );
        assert!(payload.get("text").is_none());
        assert!(payload.get("id").is_none());
    }

    #[test]
    fn normalizes_voice_speech_payload_aliases_for_voice_ref() {
        let normalized = normalize_tool_call(
            "Operate",
            &json!({
                "resource": "voice",
                "operation": "speech",
                "input": {
                    "script": "君不见黄河之水天上来。",
                    "voiceRef": "voice_2eee156a6468427bb185a831"
                }
            }),
        );

        assert_eq!(normalized.name, "workflow");
        let payload = normalized
            .arguments
            .get("payload")
            .and_then(Value::as_object)
            .expect("payload exists");
        assert_eq!(payload.get("input"), Some(&json!("君不见黄河之水天上来。")));
        assert_eq!(
            payload.get("voiceId"),
            Some(&json!("voice_2eee156a6468427bb185a831"))
        );
        assert!(payload.get("script").is_none());
        assert!(payload.get("voiceRef").is_none());
    }

    #[test]
    fn flattens_editor_payload_fields_for_structured_schema_calls() {
        let normalized = normalize_tool_call(
            "editor",
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
            "resource",
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
            "resource",
            &json!({
                "action": "workspace.search",
                "payload": { "query": "creator", "path": "docs" }
            }),
        );
        assert_eq!(normalized.arguments.get("query"), Some(&json!("creator")));
        assert_eq!(normalized.arguments.get("path"), Some(&json!("docs")));
    }

    #[test]
    fn normalizes_universal_read_to_existing_fs_tool() {
        let normalized = normalize_tool_call(
            "Read",
            &json!({ "path": "knowledge://notes/demo.md", "limit": 40 }),
        );
        assert_eq!(normalized.name, "resource");
        assert_eq!(
            normalized.arguments.get("action"),
            Some(&json!("knowledge.read"))
        );
        assert_eq!(
            normalized.arguments.get("path"),
            Some(&json!("notes/demo.md"))
        );
    }

    #[test]
    fn normalizes_universal_read_current_manuscript_to_app_cli_action() {
        let normalized = normalize_tool_call("Read", &json!({ "path": "manuscripts://current" }));
        assert_eq!(normalized.name, "workflow");
        assert_eq!(
            normalized.arguments.get("action"),
            Some(&json!("manuscripts.readCurrent"))
        );
    }

    #[test]
    fn normalizes_legacy_redclaw_profile_uri_to_profile_read() {
        let normalized = normalize_tool_call(
            "Read",
            &json!({ "path": "redclaw://profile/CreatorProfile.md" }),
        );
        assert_eq!(normalized.name, "workflow");
        assert_eq!(
            normalized.arguments.get("action"),
            Some(&json!("redclaw.profile.read"))
        );
        assert_eq!(
            normalized
                .arguments
                .get("payload")
                .and_then(|value| value.get("docType")),
            Some(&json!("creator_profile"))
        );
    }

    #[test]
    fn normalizes_legacy_redclaw_profile_uri_list_to_profile_bundle() {
        let normalized = normalize_tool_call("List", &json!({ "path": "redclaw://profile/" }));
        assert_eq!(normalized.name, "workflow");
        assert_eq!(
            normalized.arguments.get("action"),
            Some(&json!("redclaw.profile.bundle"))
        );
    }

    #[test]
    fn normalizes_universal_read_https_url_to_web_fetch() {
        let normalized = normalize_tool_call(
            "Read",
            &json!({
                "path": "https://github.com/Yeachan-Heo/oh-my-codex",
                "limit": 8000
            }),
        );
        assert_eq!(normalized.name, "workflow");
        assert_eq!(
            normalized.arguments.get("action"),
            Some(&json!("web.fetch"))
        );
        assert_eq!(
            normalized
                .arguments
                .get("payload")
                .and_then(|value| value.get("url")),
            Some(&json!("https://github.com/Yeachan-Heo/oh-my-codex"))
        );
        assert_eq!(
            normalized
                .arguments
                .get("payload")
                .and_then(|value| value.get("maxChars")),
            Some(&json!(8000))
        );
    }

    #[test]
    fn normalizes_universal_read_web_url_to_web_fetch() {
        let normalized = normalize_tool_call("Read", &json!({ "path": "web://example.com/a" }));
        assert_eq!(normalized.name, "workflow");
        assert_eq!(
            normalized.arguments.get("action"),
            Some(&json!("web.fetch"))
        );
        assert_eq!(
            normalized
                .arguments
                .get("payload")
                .and_then(|value| value.get("url")),
            Some(&json!("https://example.com/a"))
        );
    }

    #[test]
    fn normalizes_universal_search_web_to_help() {
        let normalized = normalize_tool_call(
            "Search",
            &json!({ "path": "web://", "query": "oh-my-codex" }),
        );
        assert_eq!(normalized.name, "workflow");
        assert_eq!(normalized.arguments.get("command"), Some(&json!("help")));
        assert_eq!(
            normalized
                .arguments
                .get("payload")
                .and_then(|value| value.get("operation")),
            Some(&json!("search"))
        );
    }

    #[test]
    fn normalizes_universal_write_to_bound_manuscript_save() {
        let normalized = normalize_tool_call(
            "Write",
            &json!({ "path": "manuscripts://current", "content": "body" }),
        );
        assert_eq!(normalized.name, "workflow");
        assert_eq!(
            normalized.arguments.get("action"),
            Some(&json!("manuscripts.writeCurrent"))
        );
        assert_eq!(
            normalized
                .arguments
                .get("payload")
                .and_then(|value| value.get("content")),
            Some(&json!("body"))
        );
    }

    #[test]
    fn normalizes_redbox_manuscript_write_current_to_structured_save() {
        let normalized = normalize_tool_call(
            "Operate",
            &json!({
                "resource": "manuscript",
                "operation": "writeCurrent",
                "input": { "content": "body" }
            }),
        );

        assert_eq!(normalized.name, "workflow");
        assert_eq!(
            normalized.arguments.get("action"),
            Some(&json!("manuscripts.writeCurrent"))
        );
        assert_eq!(
            normalized
                .arguments
                .get("payload")
                .and_then(|value| value.get("content")),
            Some(&json!("body"))
        );
    }

    #[test]
    fn normalizes_operate_manuscript_create_project_to_create_project_action() {
        let normalized = normalize_tool_call(
            "Operate",
            &json!({
                "resource": "manuscripts",
                "operation": "createProject",
                "input": { "kind": "post", "title": "demo" }
            }),
        );

        assert_eq!(normalized.name, "workflow");
        assert_eq!(
            normalized.arguments.get("action"),
            Some(&json!("manuscripts.createProject"))
        );
    }

    #[test]
    fn normalizes_operate_redclaw_profile_bundle_to_profile_bundle_action() {
        let normalized = normalize_tool_call(
            "Operate",
            &json!({
                "resource": "redclaw.profile",
                "operation": "bundle",
                "input": {}
            }),
        );

        assert_eq!(normalized.name, "workflow");
        assert_eq!(
            normalized.arguments.get("action"),
            Some(&json!("redclaw.profile.bundle"))
        );
    }

    #[test]
    fn normalizes_operate_redclaw_profile_complete_style_definition_action() {
        let normalized = normalize_tool_call(
            "Operate",
            &json!({
                "resource": "redclaw.profile",
                "operation": "completeStyleDefinition",
                "input": {
                    "summary": "done"
                }
            }),
        );

        assert_eq!(normalized.name, "workflow");
        assert_eq!(
            normalized.arguments.get("action"),
            Some(&json!("redclaw.profile.completeStyleDefinition"))
        );
    }

    #[test]
    fn normalizes_operate_team_resources_to_structured_actions() {
        let cases = [
            ("team.session", "create", "team.session.create"),
            ("team.session", "list", "team.session.list"),
            ("team.session", "get", "team.session.get"),
            ("team.member", "spawn", "team.member.spawn"),
            ("team.member", "list", "team.members.list"),
            ("team.task", "create", "team.task.create"),
            ("team.task", "update", "team.task.update"),
            ("team.message", "send", "team.message.send"),
            ("team.report", "request", "team.report.request"),
            ("team.report", "submit", "team.report.submit"),
            ("team.artifact", "attach", "team.artifact.attach"),
            ("team.guide", "create", "team.guide.create"),
        ];

        for (resource, operation, action) in cases {
            let normalized = normalize_tool_call(
                "Operate",
                &json!({
                    "resource": resource,
                    "operation": operation,
                    "input": { "sessionId": "collab-session-1" }
                }),
            );
            assert_eq!(normalized.name, "workflow", "{resource}.{operation}");
            assert_eq!(
                normalized.arguments.get("action"),
                Some(&json!(action)),
                "{resource}.{operation}"
            );
            assert_eq!(normalized.arguments.get("command"), None);
        }
    }

    #[test]
    fn normalizes_operate_session_resources_to_structured_actions() {
        let cases = [
            ("session", "list", "session.resources.list"),
            ("session.resources", "get", "session.resources.get"),
        ];

        for (resource, operation, action) in cases {
            let normalized = normalize_tool_call(
                "Operate",
                &json!({
                    "resource": resource,
                    "operation": operation,
                    "input": { "kind": "image", "id": "media-1" }
                }),
            );
            assert_eq!(normalized.name, "workflow", "{resource}.{operation}");
            assert_eq!(
                normalized.arguments.get("action"),
                Some(&json!(action)),
                "{resource}.{operation}"
            );
        }
    }

    #[test]
    fn normalizes_redbox_skill_invoke_id_to_name() {
        let normalized = normalize_tool_call(
            "Operate",
            &json!({
                "resource": "skill",
                "operation": "invoke",
                "id": "writing-style"
            }),
        );

        assert_eq!(normalized.name, "workflow");
        assert_eq!(
            normalized.arguments.get("action"),
            Some(&json!("skills.invoke"))
        );
        assert_eq!(
            normalized
                .arguments
                .get("payload")
                .and_then(|value| value.get("name")),
            Some(&json!("writing-style"))
        );
    }

    #[test]
    fn normalizes_redbox_image_generate_to_app_cli_action() {
        let normalized = normalize_tool_call(
            "Operate",
            &json!({
                "resource": "image",
                "operation": "generate",
                "input": { "prompt": "cover" }
            }),
        );
        assert_eq!(normalized.name, "workflow");
        assert_eq!(
            normalized.arguments.get("action"),
            Some(&json!("image.generate"))
        );
        assert_eq!(
            normalized
                .arguments
                .get("payload")
                .and_then(|value| value.get("prompt")),
            Some(&json!("cover"))
        );
    }

    #[test]
    fn normalizes_media_video_retalk_to_app_cli_action() {
        let normalized = normalize_tool_call(
            "Operate",
            &json!({
                "resource": "media",
                "operation": "videoRetalk",
                "input": {
                    "input": {
                        "video_url": "https://example.com/input.mp4",
                        "audio_url": "https://example.com/audio.wav"
                    },
                    "durationSeconds": 8,
                    "resolution": "720p"
                }
            }),
        );
        assert_eq!(normalized.name, "workflow");
        assert_eq!(
            normalized.arguments.get("action"),
            Some(&json!("media.videoRetalk"))
        );
        assert_eq!(
            normalized
                .arguments
                .get("payload")
                .and_then(|value| value.get("durationSeconds")),
            Some(&json!(8))
        );
    }

    #[test]
    fn redbox_task_legacy_resource_is_not_mapped() {
        let normalized = normalize_tool_call(
            "Operate",
            &json!({
                "resource": "task",
                "operation": "create",
                "input": {
                    "name": "视频制作团队",
                    "goal": "短视频从脚本、分镜到剪辑的协作团队"
                }
            }),
        );

        assert_eq!(normalized.name, "workflow");
        assert_eq!(normalized.arguments.get("action"), None);
        assert_eq!(normalized.arguments.get("command"), Some(&json!("help")));
        assert_eq!(
            normalized
                .arguments
                .get("__compat")
                .and_then(|value| value.get("legacyCommand")),
            Some(&json!("unknown"))
        );
    }

    #[test]
    fn normalizes_redbox_cli_runtime_get_execution_id_to_execution_get() {
        let normalized = normalize_tool_call(
            "Operate",
            &json!({
                "resource": "cli_runtime",
                "operation": "get",
                "id": "cli-exec-123"
            }),
        );

        assert_eq!(normalized.name, "workflow");
        assert_eq!(
            normalized.arguments.get("action"),
            Some(&json!("cli_runtime.execution.get"))
        );
        assert_eq!(
            normalized
                .arguments
                .get("payload")
                .and_then(|value| value.get("id")),
            Some(&json!("cli-exec-123"))
        );
    }

    #[test]
    fn normalizes_redbox_web_get_to_web_fetch() {
        let normalized = normalize_tool_call(
            "Operate",
            &json!({
                "resource": "web",
                "operation": "get",
                "input": { "url": "https://example.com" }
            }),
        );
        assert_eq!(normalized.name, "workflow");
        assert_eq!(
            normalized.arguments.get("action"),
            Some(&json!("web.fetch"))
        );
        assert_eq!(
            normalized
                .arguments
                .get("payload")
                .and_then(|value| value.get("url")),
            Some(&json!("https://example.com"))
        );
    }

    #[test]
    fn normalizes_redbox_cli_runtime_inspect_to_structured_action() {
        let normalized = normalize_tool_call(
            "Operate",
            &json!({
                "resource": "cli_runtime",
                "operation": "inspect",
                "input": { "command": "lark-cli" }
            }),
        );
        assert_eq!(normalized.name, "workflow");
        assert_eq!(
            normalized.arguments.get("action"),
            Some(&json!("cli_runtime.inspect"))
        );
        assert_eq!(
            normalized
                .arguments
                .get("payload")
                .and_then(|value| value.get("command")),
            Some(&json!("lark-cli"))
        );
    }

    #[test]
    fn normalizes_redbox_cli_runtime_run_with_nested_action_to_that_action() {
        let normalized = normalize_tool_call(
            "Operate",
            &json!({
                "resource": "cli_runtime",
                "operation": "run",
                "input": {
                    "action": "cli_runtime.inspect",
                    "command": "lark-cli"
                }
            }),
        );
        assert_eq!(normalized.name, "workflow");
        assert_eq!(
            normalized.arguments.get("action"),
            Some(&json!("cli_runtime.inspect"))
        );
        assert_eq!(
            normalized
                .arguments
                .get("payload")
                .and_then(|value| value.get("command")),
            Some(&json!("lark-cli"))
        );
        assert_eq!(
            normalized
                .arguments
                .get("payload")
                .and_then(|value| value.get("action")),
            None
        );
    }

    #[test]
    fn normalizes_redbox_cli_runtime_run_with_argv_to_execute() {
        let normalized = normalize_tool_call(
            "Operate",
            &json!({
                "resource": "cli_runtime",
                "operation": "run",
                "input": {
                    "argv": ["lark-cli", "--version"]
                }
            }),
        );
        assert_eq!(normalized.name, "workflow");
        assert_eq!(
            normalized.arguments.get("action"),
            Some(&json!("cli_runtime.execute"))
        );
        assert_eq!(
            normalized
                .arguments
                .get("payload")
                .and_then(|value| value.get("argv")),
            Some(&json!(["lark-cli", "--version"]))
        );
    }

    #[test]
    fn normalizes_redbox_cli_runtime_id_inspect_to_command_alias() {
        let normalized = normalize_tool_call(
            "Operate",
            &json!({
                "resource": "cli_runtime",
                "operation": "inspect",
                "id": "lark-cli"
            }),
        );
        assert_eq!(normalized.name, "workflow");
        assert_eq!(
            normalized.arguments.get("action"),
            Some(&json!("cli_runtime.inspect"))
        );
        assert_eq!(
            normalized
                .arguments
                .get("payload")
                .and_then(|value| value.get("id")),
            Some(&json!("lark-cli"))
        );
    }

    #[test]
    fn normalizes_redbox_cli_runtime_verify_without_execution_to_diagnose() {
        let normalized = normalize_tool_call(
            "Operate",
            &json!({
                "resource": "cli_runtime",
                "operation": "verify",
                "id": "lark-cli"
            }),
        );
        assert_eq!(normalized.name, "workflow");
        assert_eq!(
            normalized.arguments.get("action"),
            Some(&json!("cli_runtime.diagnose"))
        );
        assert_eq!(
            normalized
                .arguments
                .get("payload")
                .and_then(|value| value.get("id")),
            Some(&json!("lark-cli"))
        );
    }

    #[test]
    fn normalizes_redbox_cli_runtime_get_execution_snapshot() {
        let normalized = normalize_tool_call(
            "Operate",
            &json!({
                "resource": "cli_runtime",
                "operation": "get",
                "id": "cli-exec-123"
            }),
        );
        assert_eq!(normalized.name, "workflow");
        assert_eq!(
            normalized.arguments.get("action"),
            Some(&json!("cli_runtime.execution.get"))
        );
        assert_eq!(
            normalized
                .arguments
                .get("payload")
                .and_then(|value| value.get("id")),
            Some(&json!("cli-exec-123"))
        );
    }
}
