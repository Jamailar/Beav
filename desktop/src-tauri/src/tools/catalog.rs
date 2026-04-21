use serde::Serialize;
use serde_json::{json, Value};

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolKind {
    AppCli,
    Bash,
    AppQuery,
    FileSystem,
    ProfileDoc,
    Mcp,
    Skill,
    RuntimeControl,
    Editor,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolDescriptor {
    pub name: &'static str,
    pub description: &'static str,
    pub kind: ToolKind,
    pub requires_approval: bool,
    pub concurrency_safe: bool,
    pub output_budget_chars: usize,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ActionVisibility {
    Model,
    CompatOnly,
}

#[derive(Debug, Clone, Copy)]
pub struct ActionDescriptor {
    pub action: &'static str,
    pub namespace: &'static str,
    pub description: &'static str,
    #[allow(dead_code)]
    pub input_schema: fn() -> Value,
    #[allow(dead_code)]
    pub output_schema: fn() -> Value,
    pub mutating: bool,
    #[allow(dead_code)]
    pub concurrency_safe: bool,
    pub runtime_modes: &'static [&'static str],
    pub visibility: ActionVisibility,
}

const APP_CLI_DESCRIPTION: &str =
    "Structured business actions for the current runtime mode. Always call it with `action` and an optional `payload` object.";
const REDBOX_EDITOR_DESCRIPTION: &str =
    "Structured editor actions for the currently bound video/audio manuscript package. Use the script-first flow and controlled ffmpeg/remotion actions.";
const ALL_APP_RUNTIME_MODES: &[&str] = &[
    "chatroom",
    "default",
    "knowledge",
    "redclaw",
    "background-maintenance",
    "video-editor",
    "audio-editor",
    "diagnostics",
];
const ALL_EDITOR_RUNTIME_MODES: &[&str] = &["video-editor", "audio-editor", "diagnostics"];
const REDCLAW_RUNTIME_MODES: &[&str] = &["chatroom", "default", "knowledge", "redclaw"];
const DIAGNOSTIC_RUNTIME_MODES: &[&str] = &["background-maintenance", "redclaw", "diagnostics"];

fn string_schema(description: &str) -> Value {
    json!({
        "type": "string",
        "description": description,
    })
}

fn bool_schema(description: &str) -> Value {
    json!({
        "type": "boolean",
        "description": description,
    })
}

fn integer_schema(description: &str, minimum: i64, maximum: i64) -> Value {
    json!({
        "type": "integer",
        "description": description,
        "minimum": minimum,
        "maximum": maximum,
    })
}

fn object_schema(
    properties: &[(&str, Value)],
    required: &[&str],
    description: Option<&str>,
) -> Value {
    let mut object = serde_json::Map::<String, Value>::new();
    object.insert("type".to_string(), json!("object"));
    if let Some(text) = description.filter(|item| !item.trim().is_empty()) {
        object.insert("description".to_string(), json!(text));
    }
    let mut props = serde_json::Map::<String, Value>::new();
    for (key, value) in properties {
        props.insert((*key).to_string(), value.clone());
    }
    object.insert("properties".to_string(), Value::Object(props));
    if !required.is_empty() {
        object.insert("required".to_string(), json!(required));
    }
    object.insert("additionalProperties".to_string(), json!(false));
    Value::Object(object)
}

fn no_payload_schema() -> Value {
    object_schema(&[], &[], None)
}

fn ok_output_schema(data_schema: Value) -> Value {
    object_schema(
        &[
            ("ok", bool_schema("Whether the action succeeded.")),
            ("action", string_schema("Canonical action id.")),
            ("data", data_schema),
        ],
        &["ok", "action"],
        Some("Successful tool result envelope."),
    )
}

#[allow(dead_code)]
fn error_output_schema() -> Value {
    object_schema(
        &[
            ("ok", bool_schema("Always false for a failed action.")),
            (
                "action",
                string_schema("Canonical action id when available."),
            ),
            (
                "error",
                object_schema(
                    &[
                        ("code", string_schema("Stable machine-readable error code.")),
                        ("message", string_schema("Human-readable error summary.")),
                        ("retryable", bool_schema("Whether retrying may succeed.")),
                        (
                            "details",
                            json!({
                                "type": "object",
                                "additionalProperties": true,
                            }),
                        ),
                    ],
                    &["code", "message", "retryable"],
                    Some("Structured failure details."),
                ),
            ),
        ],
        &["ok", "error"],
        Some("Failed tool result envelope."),
    )
}

fn memory_list_input_schema() -> Value {
    no_payload_schema()
}

fn memory_search_input_schema() -> Value {
    object_schema(
        &[(
            "query",
            string_schema("Free-text search query for durable memory."),
        )],
        &["query"],
        None,
    )
}

fn memory_add_input_schema() -> Value {
    object_schema(
        &[
            ("content", string_schema("Memory text to persist.")),
            ("category", string_schema("Optional memory category.")),
        ],
        &["content"],
        None,
    )
}

fn memory_output_schema() -> Value {
    ok_output_schema(json!({
        "type": "object",
        "properties": {
            "items": { "type": "array", "items": { "type": "object" } },
            "item": { "type": "object" },
            "count": { "type": "integer", "minimum": 0 }
        },
        "additionalProperties": true
    }))
}

fn redclaw_profile_bundle_input_schema() -> Value {
    no_payload_schema()
}

fn redclaw_profile_read_input_schema() -> Value {
    object_schema(
        &[(
            "docType",
            json!({
                "type": "string",
                "enum": ["agent", "soul", "user", "creator_profile"],
            }),
        )],
        &["docType"],
        None,
    )
}

fn redclaw_profile_update_input_schema() -> Value {
    object_schema(
        &[
            (
                "docType",
                json!({
                    "type": "string",
                    "enum": ["agent", "soul", "user", "creator_profile"],
                }),
            ),
            ("markdown", string_schema("Replacement Markdown content.")),
            ("reason", string_schema("Optional update rationale.")),
        ],
        &["docType", "markdown"],
        None,
    )
}

fn redclaw_profile_output_schema() -> Value {
    ok_output_schema(json!({
        "type": "object",
        "properties": {
            "docType": { "type": "string" },
            "markdown": { "type": "string" },
            "updatedAt": { "type": "string" },
            "target": { "type": "string" }
        },
        "additionalProperties": true
    }))
}

fn redclaw_runner_status_input_schema() -> Value {
    no_payload_schema()
}

fn redclaw_runner_mutation_input_schema() -> Value {
    object_schema(
        &[(
            "config",
            json!({
                "type": "object",
                "additionalProperties": true,
            }),
        )],
        &[],
        None,
    )
}

fn generic_state_output_schema() -> Value {
    ok_output_schema(json!({
        "type": "object",
        "additionalProperties": true
    }))
}

fn manuscripts_list_input_schema() -> Value {
    no_payload_schema()
}

fn manuscripts_create_project_input_schema() -> Value {
    object_schema(
        &[
            (
                "kind",
                json!({
                    "type": "string",
                    "enum": ["redpost", "redarticle"],
                }),
            ),
            ("title", string_schema("User-visible manuscript title.")),
            (
                "parent",
                string_schema("Optional workspace subdirectory under manuscripts/."),
            ),
        ],
        &["kind", "title"],
        None,
    )
}

fn manuscripts_write_current_input_schema() -> Value {
    object_schema(
        &[(
            "content",
            string_schema("Complete manuscript Markdown body."),
        )],
        &["content"],
        None,
    )
}

fn manuscripts_output_schema() -> Value {
    ok_output_schema(json!({
        "type": "object",
        "properties": {
            "projectPath": { "type": "string" },
            "contentPath": { "type": "string" },
            "savedBytes": { "type": "integer", "minimum": 0 },
            "count": { "type": "integer", "minimum": 0 },
            "items": { "type": "array", "items": { "type": "object" } }
        },
        "additionalProperties": true
    }))
}

fn subjects_search_input_schema() -> Value {
    object_schema(
        &[
            ("query", string_schema("Free-text subject search query.")),
            ("categoryId", string_schema("Optional category filter.")),
        ],
        &["query"],
        None,
    )
}

fn subjects_get_input_schema() -> Value {
    object_schema(&[("id", string_schema("Subject id."))], &["id"], None)
}

fn subjects_output_schema() -> Value {
    ok_output_schema(json!({
        "type": "object",
        "properties": {
            "subject": { "type": "object" },
            "subjects": { "type": "array", "items": { "type": "object" } }
        },
        "additionalProperties": true
    }))
}

fn runtime_simple_input_schema() -> Value {
    object_schema(
        &[
            ("sessionId", string_schema("Optional session id.")),
            ("taskId", string_schema("Optional task id.")),
            ("limit", integer_schema("Optional result limit.", 1, 200)),
        ],
        &[],
        None,
    )
}

fn runtime_create_task_input_schema() -> Value {
    object_schema(
        &[
            ("title", string_schema("Task title.")),
            ("message", string_schema("Task prompt.")),
            (
                "modelConfig",
                json!({
                    "type": "object",
                    "additionalProperties": true,
                }),
            ),
        ],
        &["title", "message"],
        None,
    )
}

fn runtime_output_schema() -> Value {
    ok_output_schema(json!({
        "type": "object",
        "additionalProperties": true
    }))
}

fn mcp_list_input_schema() -> Value {
    no_payload_schema()
}

fn mcp_call_input_schema() -> Value {
    object_schema(
        &[
            ("serverId", string_schema("Target MCP server id.")),
            ("method", string_schema("Method name.")),
            (
                "params",
                json!({
                    "type": "object",
                    "additionalProperties": true,
                }),
            ),
        ],
        &["serverId", "method"],
        None,
    )
}

fn mcp_named_server_input_schema() -> Value {
    object_schema(
        &[("serverId", string_schema("Target MCP server id."))],
        &["serverId"],
        None,
    )
}

fn skills_invoke_input_schema() -> Value {
    object_schema(
        &[("name", string_schema("Skill name to activate."))],
        &["name"],
        None,
    )
}

fn skills_list_input_schema() -> Value {
    no_payload_schema()
}

fn image_generate_input_schema() -> Value {
    object_schema(
        &[
            ("prompt", string_schema("Image generation prompt.")),
            (
                "referenceImages",
                json!({
                    "type": "array",
                    "items": { "type": "string" },
                    "maxItems": 5,
                }),
            ),
            ("generationMode", string_schema("Generation mode.")),
        ],
        &["prompt"],
        None,
    )
}

fn video_generate_input_schema() -> Value {
    object_schema(
        &[
            ("prompt", string_schema("Video generation prompt.")),
            (
                "referenceImages",
                json!({
                    "type": "array",
                    "items": { "type": "string" },
                    "maxItems": 5,
                }),
            ),
            ("generationMode", string_schema("Video generation mode.")),
            (
                "drivingAudio",
                string_schema("Optional driving audio path."),
            ),
            (
                "videoProjectPath",
                string_schema("Optional bound video project path."),
            ),
        ],
        &["prompt"],
        None,
    )
}

fn media_output_schema() -> Value {
    ok_output_schema(json!({
        "type": "object",
        "additionalProperties": true
    }))
}

fn editor_file_locator_schema() -> Value {
    json!({
        "type": "string",
        "description": "Optional explicit file path when no session-bound editor target exists.",
    })
}

fn editor_script_read_input_schema() -> Value {
    object_schema(&[("filePath", editor_file_locator_schema())], &[], None)
}

fn editor_script_update_input_schema() -> Value {
    object_schema(
        &[
            ("filePath", editor_file_locator_schema()),
            ("content", string_schema("Full script Markdown content.")),
            (
                "source",
                json!({
                    "type": "string",
                    "enum": ["user", "ai", "system"],
                }),
            ),
        ],
        &["content"],
        None,
    )
}

fn editor_ffmpeg_edit_input_schema() -> Value {
    object_schema(
        &[
            ("filePath", editor_file_locator_schema()),
            (
                "operations",
                json!({
                    "type": "array",
                    "items": { "type": "object" },
                }),
            ),
            ("intentSummary", string_schema("Concise edit summary.")),
        ],
        &["operations"],
        None,
    )
}

fn editor_remotion_generate_input_schema() -> Value {
    object_schema(
        &[
            ("filePath", editor_file_locator_schema()),
            (
                "instructions",
                string_schema("Remotion generation instructions."),
            ),
            (
                "scene",
                json!({ "type": "object", "additionalProperties": true }),
            ),
        ],
        &["instructions"],
        None,
    )
}

fn editor_export_input_schema() -> Value {
    object_schema(
        &[
            ("filePath", editor_file_locator_schema()),
            (
                "renderMode",
                json!({
                    "type": "string",
                    "enum": ["full", "motion-layer"],
                }),
            ),
        ],
        &[],
        None,
    )
}

fn editor_output_schema() -> Value {
    ok_output_schema(json!({
        "type": "object",
        "additionalProperties": true
    }))
}

const APP_CLI_ACTIONS: &[ActionDescriptor] = &[
    ActionDescriptor {
        action: "memory.list",
        namespace: "memory",
        description: "List durable memory entries for the current workspace.",
        input_schema: memory_list_input_schema,
        output_schema: memory_output_schema,
        mutating: false,
        concurrency_safe: true,
        runtime_modes: REDCLAW_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
    ActionDescriptor {
        action: "memory.search",
        namespace: "memory",
        description: "Search durable memory entries by text query.",
        input_schema: memory_search_input_schema,
        output_schema: memory_output_schema,
        mutating: false,
        concurrency_safe: true,
        runtime_modes: REDCLAW_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
    ActionDescriptor {
        action: "memory.add",
        namespace: "memory",
        description: "Persist a durable memory entry.",
        input_schema: memory_add_input_schema,
        output_schema: memory_output_schema,
        mutating: true,
        concurrency_safe: false,
        runtime_modes: REDCLAW_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
    ActionDescriptor {
        action: "redclaw.profile.bundle",
        namespace: "redclaw.profile",
        description: "Read the RedClaw profile bundle and onboarding state.",
        input_schema: redclaw_profile_bundle_input_schema,
        output_schema: redclaw_profile_output_schema,
        mutating: false,
        concurrency_safe: true,
        runtime_modes: REDCLAW_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
    ActionDescriptor {
        action: "redclaw.profile.read",
        namespace: "redclaw.profile",
        description: "Read one durable RedClaw profile document.",
        input_schema: redclaw_profile_read_input_schema,
        output_schema: redclaw_profile_output_schema,
        mutating: false,
        concurrency_safe: true,
        runtime_modes: REDCLAW_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
    ActionDescriptor {
        action: "redclaw.profile.update",
        namespace: "redclaw.profile",
        description: "Update one durable RedClaw profile document.",
        input_schema: redclaw_profile_update_input_schema,
        output_schema: redclaw_profile_output_schema,
        mutating: true,
        concurrency_safe: false,
        runtime_modes: REDCLAW_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
    ActionDescriptor {
        action: "redclaw.runner.status",
        namespace: "redclaw.runner",
        description: "Inspect RedClaw runner and heartbeat state.",
        input_schema: redclaw_runner_status_input_schema,
        output_schema: generic_state_output_schema,
        mutating: false,
        concurrency_safe: true,
        runtime_modes: REDCLAW_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
    ActionDescriptor {
        action: "redclaw.runner.start",
        namespace: "redclaw.runner",
        description: "Start the RedClaw runner.",
        input_schema: redclaw_runner_mutation_input_schema,
        output_schema: generic_state_output_schema,
        mutating: true,
        concurrency_safe: false,
        runtime_modes: REDCLAW_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
    ActionDescriptor {
        action: "redclaw.runner.stop",
        namespace: "redclaw.runner",
        description: "Stop the RedClaw runner.",
        input_schema: no_payload_schema,
        output_schema: generic_state_output_schema,
        mutating: true,
        concurrency_safe: false,
        runtime_modes: REDCLAW_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
    ActionDescriptor {
        action: "redclaw.runner.setConfig",
        namespace: "redclaw.runner",
        description: "Update RedClaw runner configuration.",
        input_schema: redclaw_runner_mutation_input_schema,
        output_schema: generic_state_output_schema,
        mutating: true,
        concurrency_safe: false,
        runtime_modes: REDCLAW_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
    ActionDescriptor {
        action: "manuscripts.list",
        namespace: "manuscripts",
        description: "List manuscript tree items.",
        input_schema: manuscripts_list_input_schema,
        output_schema: manuscripts_output_schema,
        mutating: false,
        concurrency_safe: true,
        runtime_modes: REDCLAW_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
    ActionDescriptor {
        action: "manuscripts.createProject",
        namespace: "manuscripts",
        description: "Create and bind a manuscript project package.",
        input_schema: manuscripts_create_project_input_schema,
        output_schema: manuscripts_output_schema,
        mutating: true,
        concurrency_safe: false,
        runtime_modes: REDCLAW_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
    ActionDescriptor {
        action: "manuscripts.writeCurrent",
        namespace: "manuscripts",
        description: "Write the full manuscript body into the current bound project.",
        input_schema: manuscripts_write_current_input_schema,
        output_schema: manuscripts_output_schema,
        mutating: true,
        concurrency_safe: false,
        runtime_modes: REDCLAW_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
    ActionDescriptor {
        action: "subjects.search",
        namespace: "subjects",
        description: "Search subjects in the subject library.",
        input_schema: subjects_search_input_schema,
        output_schema: subjects_output_schema,
        mutating: false,
        concurrency_safe: true,
        runtime_modes: ALL_APP_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
    ActionDescriptor {
        action: "subjects.get",
        namespace: "subjects",
        description: "Read one subject by id.",
        input_schema: subjects_get_input_schema,
        output_schema: subjects_output_schema,
        mutating: false,
        concurrency_safe: true,
        runtime_modes: ALL_APP_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
    ActionDescriptor {
        action: "runtime.query",
        namespace: "runtime",
        description: "Inspect runtime state for a session or task.",
        input_schema: runtime_simple_input_schema,
        output_schema: runtime_output_schema,
        mutating: false,
        concurrency_safe: true,
        runtime_modes: DIAGNOSTIC_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
    ActionDescriptor {
        action: "runtime.getCheckpoints",
        namespace: "runtime",
        description: "Read runtime checkpoints for a session.",
        input_schema: runtime_simple_input_schema,
        output_schema: runtime_output_schema,
        mutating: false,
        concurrency_safe: true,
        runtime_modes: DIAGNOSTIC_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
    ActionDescriptor {
        action: "runtime.getToolResults",
        namespace: "runtime",
        description: "Read runtime tool results for a session.",
        input_schema: runtime_simple_input_schema,
        output_schema: runtime_output_schema,
        mutating: false,
        concurrency_safe: true,
        runtime_modes: DIAGNOSTIC_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
    ActionDescriptor {
        action: "runtime.tasks.create",
        namespace: "runtime.tasks",
        description: "Create a runtime task.",
        input_schema: runtime_create_task_input_schema,
        output_schema: runtime_output_schema,
        mutating: true,
        concurrency_safe: false,
        runtime_modes: DIAGNOSTIC_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
    ActionDescriptor {
        action: "runtime.tasks.list",
        namespace: "runtime.tasks",
        description: "List runtime tasks.",
        input_schema: runtime_simple_input_schema,
        output_schema: runtime_output_schema,
        mutating: false,
        concurrency_safe: true,
        runtime_modes: DIAGNOSTIC_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
    ActionDescriptor {
        action: "runtime.tasks.get",
        namespace: "runtime.tasks",
        description: "Read one runtime task.",
        input_schema: runtime_simple_input_schema,
        output_schema: runtime_output_schema,
        mutating: false,
        concurrency_safe: true,
        runtime_modes: DIAGNOSTIC_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
    ActionDescriptor {
        action: "runtime.tasks.resume",
        namespace: "runtime.tasks",
        description: "Resume a paused runtime task.",
        input_schema: runtime_simple_input_schema,
        output_schema: runtime_output_schema,
        mutating: true,
        concurrency_safe: false,
        runtime_modes: DIAGNOSTIC_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
    ActionDescriptor {
        action: "runtime.tasks.cancel",
        namespace: "runtime.tasks",
        description: "Cancel a runtime task.",
        input_schema: runtime_simple_input_schema,
        output_schema: runtime_output_schema,
        mutating: true,
        concurrency_safe: false,
        runtime_modes: DIAGNOSTIC_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
    ActionDescriptor {
        action: "mcp.list",
        namespace: "mcp",
        description: "List MCP server records.",
        input_schema: mcp_list_input_schema,
        output_schema: generic_state_output_schema,
        mutating: false,
        concurrency_safe: true,
        runtime_modes: DIAGNOSTIC_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
    ActionDescriptor {
        action: "mcp.call",
        namespace: "mcp",
        description: "Call one MCP tool or method.",
        input_schema: mcp_call_input_schema,
        output_schema: generic_state_output_schema,
        mutating: true,
        concurrency_safe: false,
        runtime_modes: DIAGNOSTIC_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
    ActionDescriptor {
        action: "mcp.listTools",
        namespace: "mcp",
        description: "List tools exposed by one MCP server.",
        input_schema: mcp_named_server_input_schema,
        output_schema: generic_state_output_schema,
        mutating: false,
        concurrency_safe: true,
        runtime_modes: DIAGNOSTIC_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
    ActionDescriptor {
        action: "mcp.listResources",
        namespace: "mcp",
        description: "List resources exposed by one MCP server.",
        input_schema: mcp_named_server_input_schema,
        output_schema: generic_state_output_schema,
        mutating: false,
        concurrency_safe: true,
        runtime_modes: DIAGNOSTIC_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
    ActionDescriptor {
        action: "mcp.disconnect",
        namespace: "mcp",
        description: "Disconnect one MCP server session.",
        input_schema: mcp_named_server_input_schema,
        output_schema: generic_state_output_schema,
        mutating: true,
        concurrency_safe: false,
        runtime_modes: DIAGNOSTIC_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
    ActionDescriptor {
        action: "skills.list",
        namespace: "skills",
        description: "List visible skills in the current runtime.",
        input_schema: skills_list_input_schema,
        output_schema: generic_state_output_schema,
        mutating: false,
        concurrency_safe: true,
        runtime_modes: ALL_APP_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
    ActionDescriptor {
        action: "skills.invoke",
        namespace: "skills",
        description: "Activate one skill in the current session.",
        input_schema: skills_invoke_input_schema,
        output_schema: generic_state_output_schema,
        mutating: true,
        concurrency_safe: false,
        runtime_modes: ALL_APP_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
    ActionDescriptor {
        action: "image.generate",
        namespace: "image",
        description: "Generate or edit images with the configured provider.",
        input_schema: image_generate_input_schema,
        output_schema: media_output_schema,
        mutating: true,
        concurrency_safe: false,
        runtime_modes: REDCLAW_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
    ActionDescriptor {
        action: "video.generate",
        namespace: "video",
        description: "Generate videos with the configured provider.",
        input_schema: video_generate_input_schema,
        output_schema: media_output_schema,
        mutating: true,
        concurrency_safe: false,
        runtime_modes: REDCLAW_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
];

const REDBOX_EDITOR_ACTIONS: &[ActionDescriptor] = &[
    ActionDescriptor {
        action: "script_read",
        namespace: "script",
        description: "Read the current script state for the bound package.",
        input_schema: editor_script_read_input_schema,
        output_schema: editor_output_schema,
        mutating: false,
        concurrency_safe: true,
        runtime_modes: ALL_EDITOR_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
    ActionDescriptor {
        action: "script_update",
        namespace: "script",
        description: "Replace the current script draft content.",
        input_schema: editor_script_update_input_schema,
        output_schema: editor_output_schema,
        mutating: true,
        concurrency_safe: false,
        runtime_modes: ALL_EDITOR_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
    ActionDescriptor {
        action: "script_confirm",
        namespace: "script",
        description: "Confirm the current script for downstream editing.",
        input_schema: editor_script_read_input_schema,
        output_schema: editor_output_schema,
        mutating: true,
        concurrency_safe: false,
        runtime_modes: ALL_EDITOR_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
    ActionDescriptor {
        action: "project_read",
        namespace: "project",
        description: "Read the bound editor project state.",
        input_schema: editor_script_read_input_schema,
        output_schema: editor_output_schema,
        mutating: false,
        concurrency_safe: true,
        runtime_modes: ALL_EDITOR_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
    ActionDescriptor {
        action: "ffmpeg_edit",
        namespace: "ffmpeg",
        description: "Apply controlled ffmpeg editing operations.",
        input_schema: editor_ffmpeg_edit_input_schema,
        output_schema: editor_output_schema,
        mutating: true,
        concurrency_safe: false,
        runtime_modes: ALL_EDITOR_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
    ActionDescriptor {
        action: "remotion_read",
        namespace: "remotion",
        description: "Read the current Remotion context.",
        input_schema: editor_script_read_input_schema,
        output_schema: editor_output_schema,
        mutating: false,
        concurrency_safe: true,
        runtime_modes: ALL_EDITOR_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
    ActionDescriptor {
        action: "remotion_generate",
        namespace: "remotion",
        description: "Generate or update Remotion overlays from instructions.",
        input_schema: editor_remotion_generate_input_schema,
        output_schema: editor_output_schema,
        mutating: true,
        concurrency_safe: false,
        runtime_modes: ALL_EDITOR_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
    ActionDescriptor {
        action: "remotion_save",
        namespace: "remotion",
        description: "Persist the current Remotion scene state.",
        input_schema: editor_remotion_generate_input_schema,
        output_schema: editor_output_schema,
        mutating: true,
        concurrency_safe: false,
        runtime_modes: ALL_EDITOR_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
    ActionDescriptor {
        action: "export",
        namespace: "export",
        description: "Export the current editor project output.",
        input_schema: editor_export_input_schema,
        output_schema: editor_output_schema,
        mutating: true,
        concurrency_safe: false,
        runtime_modes: ALL_EDITOR_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
    ActionDescriptor {
        action: "timeline_read",
        namespace: "legacy_timeline",
        description: "Legacy timeline inspection action kept for compatibility only.",
        input_schema: editor_script_read_input_schema,
        output_schema: editor_output_schema,
        mutating: false,
        concurrency_safe: true,
        runtime_modes: ALL_EDITOR_RUNTIME_MODES,
        visibility: ActionVisibility::CompatOnly,
    },
    ActionDescriptor {
        action: "clip_add",
        namespace: "legacy_timeline",
        description: "Legacy timeline mutation kept for compatibility only.",
        input_schema: editor_ffmpeg_edit_input_schema,
        output_schema: editor_output_schema,
        mutating: true,
        concurrency_safe: false,
        runtime_modes: ALL_EDITOR_RUNTIME_MODES,
        visibility: ActionVisibility::CompatOnly,
    },
    ActionDescriptor {
        action: "undo",
        namespace: "legacy_timeline",
        description: "Legacy undo action kept for compatibility only.",
        input_schema: editor_script_read_input_schema,
        output_schema: editor_output_schema,
        mutating: true,
        concurrency_safe: false,
        runtime_modes: ALL_EDITOR_RUNTIME_MODES,
        visibility: ActionVisibility::CompatOnly,
    },
];

fn normalized_runtime_mode(runtime_mode: Option<&str>) -> &str {
    match runtime_mode.unwrap_or("chatroom").trim() {
        "" => "chatroom",
        "default" => "chatroom",
        other => other,
    }
}

fn action_visible_in_runtime(
    descriptor: &ActionDescriptor,
    runtime_mode: Option<&str>,
    visibility: ActionVisibility,
) -> bool {
    if descriptor.visibility != visibility {
        return false;
    }
    let normalized = normalized_runtime_mode(runtime_mode);
    descriptor.runtime_modes.iter().any(|item| {
        let candidate = if *item == "default" {
            "chatroom"
        } else {
            *item
        };
        candidate == normalized
    })
}

fn build_action_tool_schema(
    tool_name: &str,
    description: &str,
    descriptors: &[ActionDescriptor],
) -> Value {
    let variants = descriptors
        .iter()
        .map(|descriptor| {
            let payload_schema = (descriptor.input_schema)();
            let payload_required = payload_schema
                .get("required")
                .and_then(Value::as_array)
                .map(|items| !items.is_empty())
                .unwrap_or(false);
            json!({
                "type": "object",
                "properties": {
                    "action": {
                        "const": descriptor.action,
                        "description": descriptor.description,
                    },
                    "payload": payload_schema,
                },
                "required": if payload_required { json!(["action", "payload"]) } else { json!(["action"]) },
                "additionalProperties": false,
            })
        })
        .collect::<Vec<_>>();
    json!({
        "type": "function",
        "function": {
            "name": tool_name,
            "description": description,
            "parameters": {
                "oneOf": variants
            }
        }
    })
}

fn action_family_summary(descriptors: &[ActionDescriptor]) -> String {
    let mut families = Vec::<String>::new();
    let mut grouped = std::collections::BTreeMap::<&str, Vec<&ActionDescriptor>>::new();
    for descriptor in descriptors {
        grouped
            .entry(descriptor.namespace)
            .or_default()
            .push(descriptor);
    }
    for (namespace, items) in grouped {
        let mutating = items.iter().filter(|item| item.mutating).count();
        let sample = items
            .iter()
            .take(3)
            .map(|item| item.action.split('.').last().unwrap_or(item.action))
            .collect::<Vec<_>>()
            .join(", ");
        if mutating > 0 {
            families.push(format!(
                "{namespace} [{} actions, {mutating} mutating: {sample}]",
                items.len()
            ));
        } else {
            families.push(format!("{namespace} [{} actions: {sample}]", items.len()));
        }
    }
    families.join("; ")
}

pub fn action_descriptors_for_tool(
    tool_name: &str,
    runtime_mode: Option<&str>,
    visibility: ActionVisibility,
) -> Vec<ActionDescriptor> {
    let source = match tool_name {
        "app_cli" => APP_CLI_ACTIONS,
        "redbox_editor" => REDBOX_EDITOR_ACTIONS,
        _ => &[],
    };
    source
        .iter()
        .copied()
        .filter(|descriptor| action_visible_in_runtime(descriptor, runtime_mode, visibility))
        .collect()
}

pub fn tool_action_family_summary(tool_name: &str, runtime_mode: Option<&str>) -> Option<String> {
    let descriptors = action_descriptors_for_tool(tool_name, runtime_mode, ActionVisibility::Model);
    if descriptors.is_empty() {
        return None;
    }
    Some(action_family_summary(&descriptors))
}

pub fn tool_action_family_summary_for_descriptors(
    descriptors: &[ActionDescriptor],
) -> Option<String> {
    if descriptors.is_empty() {
        return None;
    }
    Some(action_family_summary(descriptors))
}

#[allow(dead_code)]
pub fn action_descriptor_by_name(
    tool_name: &str,
    action: &str,
    visibility: Option<ActionVisibility>,
) -> Option<ActionDescriptor> {
    let source = match tool_name {
        "app_cli" => APP_CLI_ACTIONS,
        "redbox_editor" => REDBOX_EDITOR_ACTIONS,
        _ => return None,
    };
    source.iter().copied().find(|descriptor| {
        descriptor.action == action
            && visibility
                .map(|value| value == descriptor.visibility)
                .unwrap_or(true)
    })
}

pub fn descriptor_by_name(name: &str) -> Option<ToolDescriptor> {
    match name {
        "app_cli" => Some(ToolDescriptor {
            name: "app_cli",
            description: APP_CLI_DESCRIPTION,
            kind: ToolKind::AppCli,
            requires_approval: false,
            concurrency_safe: false,
            output_budget_chars: 20_000,
        }),
        "bash" => Some(ToolDescriptor {
            name: "bash",
            description: "Read-only shell inspection inside currentSpaceRoot. Supports pwd, ls, find, rg, cat, head, tail, sed, wc, jq, and read-only git commands.",
            kind: ToolKind::Bash,
            requires_approval: false,
            concurrency_safe: true,
            output_budget_chars: 20_000,
        }),
        "redbox_app_query" => Some(ToolDescriptor {
            name: "redbox_app_query",
            description: "Legacy compatibility alias for app queries. Prefer app_cli commands such as spaces list, advisors list, knowledge search, work list, memory search, chat sessions list, settings summary, and redclaw profile-bundle.",
            kind: ToolKind::AppQuery,
            requires_approval: false,
            concurrency_safe: true,
            output_budget_chars: 12_000,
        }),
        "redbox_fs" => Some(ToolDescriptor {
            name: "redbox_fs",
            description: "Unified structured file access for currentSpaceRoot and advisor/member knowledge. Use scope=workspace or scope=knowledge with action=list/read/search.",
            kind: ToolKind::FileSystem,
            requires_approval: false,
            concurrency_safe: true,
            output_budget_chars: 20_000,
        }),
        "knowledge_glob" => Some(ToolDescriptor {
            name: "knowledge_glob",
            description: "Legacy compatibility alias for advisor/member knowledge listing. Prefer redbox_fs(scope=knowledge, action=list).",
            kind: ToolKind::FileSystem,
            requires_approval: false,
            concurrency_safe: true,
            output_budget_chars: 16_000,
        }),
        "knowledge_grep" => Some(ToolDescriptor {
            name: "knowledge_grep",
            description: "Legacy compatibility alias for advisor/member knowledge search. Prefer redbox_fs(scope=knowledge, action=search).",
            kind: ToolKind::FileSystem,
            requires_approval: false,
            concurrency_safe: true,
            output_budget_chars: 18_000,
        }),
        "knowledge_read" => Some(ToolDescriptor {
            name: "knowledge_read",
            description: "Legacy compatibility alias for advisor/member knowledge read. Prefer redbox_fs(scope=knowledge, action=read).",
            kind: ToolKind::FileSystem,
            requires_approval: false,
            concurrency_safe: true,
            output_budget_chars: 20_000,
        }),
        "redbox_profile_doc" => Some(ToolDescriptor {
            name: "redbox_profile_doc",
            description: "Legacy compatibility alias for durable RedClaw profile doc operations. Prefer app_cli redclaw profile-bundle/profile-read/profile-update commands.",
            kind: ToolKind::ProfileDoc,
            requires_approval: false,
            concurrency_safe: false,
            output_budget_chars: 16_000,
        }),
        "redbox_mcp" => Some(ToolDescriptor {
            name: "redbox_mcp",
            description: "Legacy compatibility alias for MCP management. Prefer app_cli mcp list/save/call/list-tools/list-resources/disconnect commands.",
            kind: ToolKind::Mcp,
            requires_approval: false,
            concurrency_safe: true,
            output_budget_chars: 20_000,
        }),
        "redbox_skill" => Some(ToolDescriptor {
            name: "redbox_skill",
            description: "Legacy compatibility alias for skill runtime and AI-role management. Prefer app_cli skills ... and ai ... commands.",
            kind: ToolKind::Skill,
            requires_approval: false,
            concurrency_safe: false,
            output_budget_chars: 12_000,
        }),
        "redbox_runtime_control" => Some(ToolDescriptor {
            name: "redbox_runtime_control",
            description: "Legacy compatibility alias for runtime/session/task/background control. Prefer app_cli runtime ... commands.",
            kind: ToolKind::RuntimeControl,
            requires_approval: false,
            concurrency_safe: false,
            output_budget_chars: 20_000,
        }),
        "redbox_editor" => Some(ToolDescriptor {
            name: "redbox_editor",
            description: REDBOX_EDITOR_DESCRIPTION,
            kind: ToolKind::Editor,
            requires_approval: false,
            concurrency_safe: false,
            output_budget_chars: 24_000,
        }),
        _ => None,
    }
}

pub fn schema_for_tool_for_runtime_mode(name: &str, runtime_mode: Option<&str>) -> Option<Value> {
    match name {
        "app_cli" => Some(build_action_tool_schema(
            "app_cli",
            APP_CLI_DESCRIPTION,
            &action_descriptors_for_tool("app_cli", runtime_mode, ActionVisibility::Model),
        )),
        "bash" => Some(json!({
            "type": "function",
            "function": {
                "name": "bash",
                "description": "Read-only shell inspection inside currentSpaceRoot. Supports pwd, ls, find, rg, cat, head, tail, sed, wc, jq, and read-only git commands.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "command": { "type": "string" },
                        "cwd": { "type": "string" },
                        "maxChars": { "type": "integer", "minimum": 200, "maximum": 20000 }
                    },
                    "required": ["command"],
                    "additionalProperties": false
                }
            }
        })),
        "redbox_app_query" => Some(json!({
            "type": "function",
            "function": {
                "name": "redbox_app_query",
                "description": "Legacy compatibility alias for app queries. Prefer app_cli commands such as spaces list, advisors list, knowledge search, work list, memory search, chat sessions list, settings summary, and redclaw profile-bundle.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "operation": {
                            "type": "string",
                            "enum": [
                                "spaces.list",
                                "advisors.list",
                                "knowledge.search",
                                "work.list",
                                "memory.search",
                                "chat.sessions.list",
                                "settings.summary",
                                "redclaw.profile.bundle",
                                "redclaw.profile.onboarding"
                            ]
                        },
                        "query": { "type": "string" },
                        "status": { "type": "string" },
                        "limit": { "type": "integer", "minimum": 1, "maximum": 20 }
                    },
                    "required": ["operation"],
                    "additionalProperties": false
                }
            }
        })),
        "redbox_fs" => Some(json!({
            "type": "function",
            "function": {
                "name": "redbox_fs",
                "description": "Unified structured file access for currentSpaceRoot and advisor/member knowledge. Use scope=workspace or scope=knowledge with action=list/read/search.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "scope": { "type": "string", "enum": ["workspace", "knowledge"] },
                        "action": { "type": "string", "enum": ["list", "read", "search"] },
                        "advisorId": { "type": "string" },
                        "path": { "type": "string" },
                        "pattern": { "type": "string" },
                        "query": { "type": "string" },
                        "offset": { "type": "integer", "minimum": 0 },
                        "limit": { "type": "integer", "minimum": 1, "maximum": 400 },
                        "maxChars": { "type": "integer", "minimum": 200, "maximum": 20000 },
                        "snippetChars": { "type": "integer", "minimum": 80, "maximum": 800 }
                    },
                    "required": ["action"],
                    "additionalProperties": false
                }
            }
        })),
        "knowledge_glob" => Some(json!({
            "type": "function",
            "function": {
                "name": "knowledge_glob",
                "description": "Legacy compatibility alias for advisor/member knowledge listing. Prefer redbox_fs(scope=knowledge, action=list).",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "advisorId": { "type": "string" },
                        "pattern": { "type": "string" },
                        "limit": { "type": "integer", "minimum": 1, "maximum": 200 }
                    },
                    "additionalProperties": false
                }
            }
        })),
        "knowledge_grep" => Some(json!({
            "type": "function",
            "function": {
                "name": "knowledge_grep",
                "description": "Legacy compatibility alias for advisor/member knowledge search. Prefer redbox_fs(scope=knowledge, action=search).",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "advisorId": { "type": "string" },
                        "query": { "type": "string" },
                        "pattern": { "type": "string" },
                        "limit": { "type": "integer", "minimum": 1, "maximum": 100 },
                        "snippetChars": { "type": "integer", "minimum": 80, "maximum": 800 }
                    },
                    "required": ["query"],
                    "additionalProperties": false
                }
            }
        })),
        "knowledge_read" => Some(json!({
            "type": "function",
            "function": {
                "name": "knowledge_read",
                "description": "Legacy compatibility alias for advisor/member knowledge read. Prefer redbox_fs(scope=knowledge, action=read).",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "advisorId": { "type": "string" },
                        "path": { "type": "string" },
                        "offset": { "type": "integer", "minimum": 0 },
                        "limit": { "type": "integer", "minimum": 1, "maximum": 400 },
                        "maxChars": { "type": "integer", "minimum": 200, "maximum": 20000 }
                    },
                    "required": ["path"],
                    "additionalProperties": false
                }
            }
        })),
        "redbox_profile_doc" => Some(json!({
            "type": "function",
            "function": {
                "name": "redbox_profile_doc",
                "description": "Legacy compatibility alias for durable RedClaw profile doc operations. Prefer app_cli redclaw profile-bundle/profile-read/profile-update commands.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "action": { "type": "string", "enum": ["bundle", "read", "update"] },
                        "docType": { "type": "string", "enum": ["agent", "soul", "user", "creator_profile"] },
                        "markdown": { "type": "string" },
                        "reason": { "type": "string" }
                    },
                    "required": ["action"],
                    "additionalProperties": false
                }
            }
        })),
        "redbox_mcp" => Some(json!({
            "type": "function",
            "function": {
                "name": "redbox_mcp",
                "description": "Legacy compatibility alias for MCP management. Prefer app_cli mcp list/save/call/list-tools/list-resources/disconnect commands.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "action": {
                            "type": "string",
                            "enum": [
                                "list",
                                "save",
                                "test",
                                "call",
                                "list_tools",
                                "list_resources",
                                "list_resource_templates",
                                "sessions",
                                "disconnect",
                                "disconnect_all",
                                "discover_local",
                                "import_local",
                                "oauth_status"
                            ]
                        },
                        "server": { "type": "object" },
                        "servers": { "type": "array", "items": { "type": "object" } },
                        "method": { "type": "string" },
                        "params": { "type": "object" },
                        "serverId": { "type": "string" },
                        "sessionId": { "type": "string" }
                    },
                    "required": ["action"],
                    "additionalProperties": false
                }
            }
        })),
        "redbox_skill" => Some(json!({
            "type": "function",
            "function": {
                "name": "redbox_skill",
                "description": "Legacy compatibility alias for skill runtime and AI-role management. Prefer app_cli skills ... and ai ... commands.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "action": {
                            "type": "string",
                            "enum": ["list", "invoke", "create", "save", "enable", "disable", "market_install", "ai_roles_list", "detect_protocol", "test_connection", "fetch_models"]
                        },
                        "name": { "type": "string" },
                        "skill": { "type": "string" },
                        "location": { "type": "string" },
                        "content": { "type": "string" },
                        "slug": { "type": "string" },
                        "baseURL": { "type": "string" },
                        "apiKey": { "type": "string" },
                        "presetId": { "type": "string" },
                        "protocol": { "type": "string" }
                    },
                    "required": ["action"],
                    "additionalProperties": false
                }
            }
        })),
        "redbox_runtime_control" => Some(json!({
            "type": "function",
            "function": {
                "name": "redbox_runtime_control",
                "description": "Legacy compatibility alias for runtime/session/task/background control. Prefer app_cli runtime ... commands.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "action": {
                            "type": "string",
                            "enum": [
                                "runtime_query",
                                "runtime_resume",
                                "runtime_fork_session",
                                "runtime_get_trace",
                                "runtime_get_checkpoints",
                                "runtime_get_tool_results",
                                "tasks_create",
                                "tasks_list",
                                "tasks_get",
                                "tasks_resume",
                                "tasks_cancel",
                                "background_tasks_list",
                                "background_tasks_get",
                                "background_tasks_cancel",
                                "session_enter_diagnostics",
                                "session_bridge_status",
                                "session_bridge_list_sessions",
                                "session_bridge_get_session"
                            ]
                        },
                        "sessionId": { "type": "string" },
                        "message": { "type": "string" },
                        "modelConfig": { "type": "object" },
                        "taskId": { "type": "string" },
                        "title": { "type": "string" },
                        "contextId": { "type": "string" },
                        "contextType": { "type": "string" },
                        "limit": { "type": "integer", "minimum": 1, "maximum": 200 },
                        "payload": { "type": "object" }
                    },
                    "required": ["action"],
                    "additionalProperties": false
                }
            }
        })),
        "redbox_editor" => Some(build_action_tool_schema(
            "redbox_editor",
            REDBOX_EDITOR_DESCRIPTION,
            &action_descriptors_for_tool("redbox_editor", runtime_mode, ActionVisibility::Model),
        )),
        _ => None,
    }
}

pub fn schema_for_tool_from_action_descriptors(
    name: &str,
    descriptors: &[ActionDescriptor],
) -> Option<Value> {
    match name {
        "app_cli" => Some(build_action_tool_schema(
            "app_cli",
            APP_CLI_DESCRIPTION,
            descriptors,
        )),
        "redbox_editor" => Some(build_action_tool_schema(
            "redbox_editor",
            REDBOX_EDITOR_DESCRIPTION,
            descriptors,
        )),
        _ => None,
    }
}

#[allow(dead_code)]
pub fn schema_for_tool(name: &str) -> Option<Value> {
    schema_for_tool_for_runtime_mode(name, None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_cli_schema_supports_structured_action_field() {
        let schema = schema_for_tool_for_runtime_mode("app_cli", Some("redclaw"))
            .expect("app_cli schema should exist");
        let parameters = &schema["function"]["parameters"];
        let variants = parameters["oneOf"].as_array().expect("oneOf variants");
        assert!(variants.iter().all(|item| item.get("properties").is_some()));
        assert!(variants
            .iter()
            .all(|item| item["properties"]["action"].get("const").is_some()));
    }

    #[test]
    fn app_cli_schema_filters_actions_by_runtime_mode() {
        let schema = schema_for_tool_for_runtime_mode("app_cli", Some("diagnostics"))
            .expect("diagnostics schema should exist");
        let variants = schema["function"]["parameters"]["oneOf"]
            .as_array()
            .expect("oneOf variants");
        let actions = variants
            .iter()
            .filter_map(|item| item["properties"]["action"]["const"].as_str())
            .collect::<Vec<_>>();
        assert!(actions.contains(&"runtime.query"));
        assert!(actions.contains(&"mcp.list"));
        assert!(!actions.contains(&"manuscripts.writeCurrent"));
    }

    #[test]
    fn redbox_editor_schema_hides_compat_only_actions() {
        let schema = schema_for_tool_for_runtime_mode("redbox_editor", Some("video-editor"))
            .expect("editor schema should exist");
        let actions = schema["function"]["parameters"]["oneOf"]
            .as_array()
            .expect("oneOf variants")
            .iter()
            .filter_map(|item| item["properties"]["action"]["const"].as_str())
            .collect::<Vec<_>>();
        assert!(actions.contains(&"script_read"));
        assert!(actions.contains(&"ffmpeg_edit"));
        assert!(!actions.contains(&"timeline_read"));
        assert!(!actions.contains(&"undo"));
    }

    #[test]
    fn tool_action_family_summary_lists_namespaces() {
        let summary =
            tool_action_family_summary("app_cli", Some("redclaw")).expect("summary should exist");
        assert!(summary.contains("memory"));
        assert!(summary.contains("manuscripts"));
    }

    #[test]
    fn action_descriptor_lookup_exposes_output_schema() {
        let descriptor = action_descriptor_by_name(
            "app_cli",
            "manuscripts.writeCurrent",
            Some(ActionVisibility::Model),
        )
        .expect("descriptor should exist");
        let output = (descriptor.output_schema)();
        assert!(output.get("properties").is_some());
    }

    #[test]
    fn error_output_schema_is_structured() {
        let schema = error_output_schema();
        assert_eq!(
            schema["properties"]["error"]["type"].as_str(),
            Some("object")
        );
    }
}
