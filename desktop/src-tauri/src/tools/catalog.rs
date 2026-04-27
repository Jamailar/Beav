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
const READ_DESCRIPTION: &str =
    "Read one local, web URL, or RedBox virtual resource. Use paths like https://example.com/page, workspace://docs/a.md, knowledge://, profiles://creator_profile, manuscripts://current, editor://current/script, or editor://current/remotion. Do not use bash/curl for web pages.";
const LIST_DESCRIPTION: &str =
    "List a directory or RedBox collection. Use workspace:// for files, knowledge:// for knowledge, manuscripts:// for manuscript projects, subjects:// for subjects, or media:// for media.";
const SEARCH_DESCRIPTION: &str =
    "Search files or RedBox collections by query. Use workspace:// for workspace content, knowledge:// for advisor/shared knowledge, and subjects:// for subject library lookup. This is not a web search tool.";
const WRITE_DESCRIPTION: &str =
    "Write content to a RedBox virtual resource. Use manuscripts://current for the bound manuscript body or editor://current/script for the bound editor script.";
const REDBOX_DESCRIPTION: &str =
    "Run product-level RedBox operations that are not simple read/list/search/write, such as creating manuscripts, generating media, managing tasks, invoking skills, editor workflows, or MCP calls.";
const ALL_APP_RUNTIME_MODES: &[&str] = &[
    "chatroom",
    "default",
    "image-generation",
    "knowledge",
    "redclaw",
    "background-maintenance",
    "video-editor",
    "audio-editor",
    "diagnostics",
];
const ALL_EDITOR_RUNTIME_MODES: &[&str] = &["video-editor", "audio-editor", "diagnostics"];
const ALL_FILE_SYSTEM_RUNTIME_MODES: &[&str] = &[
    "wander",
    "chatroom",
    "image-generation",
    "knowledge",
    "redclaw",
    "video-editor",
    "audio-editor",
    "diagnostics",
];
const REDCLAW_RUNTIME_MODES: &[&str] = &[
    "chatroom",
    "default",
    "image-generation",
    "knowledge",
    "redclaw",
];
const DIAGNOSTIC_RUNTIME_MODES: &[&str] = &["background-maintenance", "diagnostics"];

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

fn image_aspect_ratio_schema(description: &str) -> Value {
    json!({
        "type": "string",
        "enum": ["1:1", "3:4", "4:3", "9:16", "16:9"],
        "description": description,
    })
}

fn image_size_schema(description: &str) -> Value {
    json!({
        "type": "string",
        "description": description,
        "enum": ["auto", "1024x1024", "1024x1536", "1536x1024"],
    })
}

fn image_quality_schema(description: &str) -> Value {
    json!({
        "type": "string",
        "description": description,
        "enum": ["auto", "standard", "high", "hd", "medium", "low"],
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
        &[
            (
                "query",
                string_schema("Free-text search query for durable memory."),
            ),
            (
                "limit",
                integer_schema("Maximum results to return.", 1, 200),
            ),
            ("scope", string_schema("Optional memory scope filter.")),
            (
                "scopes",
                json!({ "type": "array", "items": { "type": "string" } }),
            ),
            (
                "memoryTypes",
                json!({ "type": "array", "items": { "type": "string" } }),
            ),
            ("projectId", string_schema("Optional project id filter.")),
            ("sessionId", string_schema("Optional session id filter.")),
            (
                "includeArchived",
                bool_schema("Whether archived memories should be included."),
            ),
        ],
        &["query"],
        None,
    )
}

fn memory_add_input_schema() -> Value {
    object_schema(
        &[
            ("content", string_schema("Memory text to persist.")),
            (
                "type",
                string_schema(
                    "Memory type, such as fact, preference, constraint, goal, or project.",
                ),
            ),
            (
                "scope",
                string_schema(
                    "Memory scope, such as user, workspace, project, redclaw, advisor, or session.",
                ),
            ),
            (
                "category",
                string_schema("Backward-compatible alias for scope."),
            ),
            (
                "tags",
                json!({ "type": "array", "items": { "type": "string" } }),
            ),
            (
                "entities",
                json!({ "type": "array", "items": { "type": "string" } }),
            ),
            (
                "confidence",
                json!({ "type": "number", "minimum": 0.0, "maximum": 1.0 }),
            ),
            ("spaceId", string_schema("Optional space id.")),
            ("projectId", string_schema("Optional project id.")),
            ("sessionId", string_schema("Optional session id.")),
            (
                "source",
                json!({ "type": "object", "additionalProperties": true }),
            ),
        ],
        &["content"],
        None,
    )
}

fn memory_update_input_schema() -> Value {
    object_schema(
        &[
            ("id", string_schema("Memory id to update.")),
            ("content", string_schema("Updated memory text.")),
            ("type", string_schema("Updated memory type.")),
            ("scope", string_schema("Updated memory scope.")),
            (
                "tags",
                json!({ "type": "array", "items": { "type": "string" } }),
            ),
            (
                "entities",
                json!({ "type": "array", "items": { "type": "string" } }),
            ),
            (
                "confidence",
                json!({ "type": "number", "minimum": 0.0, "maximum": 1.0 }),
            ),
            ("spaceId", string_schema("Optional space id.")),
            ("projectId", string_schema("Optional project id.")),
            ("sessionId", string_schema("Optional session id.")),
            (
                "source",
                json!({ "type": "object", "additionalProperties": true }),
            ),
            ("reason", string_schema("Optional update reason.")),
        ],
        &["id"],
        None,
    )
}

fn memory_archive_input_schema() -> Value {
    object_schema(
        &[
            ("id", string_schema("Memory id to archive.")),
            ("reason", string_schema("Archive reason.")),
        ],
        &["id"],
        None,
    )
}

fn memory_recall_input_schema() -> Value {
    memory_search_input_schema()
}

fn memory_rebuild_index_input_schema() -> Value {
    no_payload_schema()
}

fn memory_diagnostics_input_schema() -> Value {
    no_payload_schema()
}

fn web_fetch_input_schema() -> Value {
    object_schema(
        &[
            ("url", string_schema("Public http/https URL to fetch.")),
            (
                "maxChars",
                integer_schema("Maximum text characters to return.", 1000, 40000),
            ),
            (
                "includeLinks",
                json!({
                    "type": "boolean",
                    "description": "Whether to include public links extracted from the page."
                }),
            ),
        ],
        &["url"],
        Some("Fetch a user-provided public web page URL. This does not perform web search."),
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

fn redclaw_task_preview_input_schema() -> Value {
    object_schema(
        &[
            (
                "kind",
                string_schema(
                    "Task kind: scheduled or long_cycle. Omit to infer scheduled unless objective/stepPrompt are present.",
                ),
            ),
            ("intent", string_schema("Stable agent intent ref.")),
            ("name", string_schema("Task title.")),
            (
                "cron",
                string_schema(
                    "5-field cron, @every Xm/Xh/Xd, or @once RFC3339. For scheduled tasks, prefer explicit 5-field cron like `50 21 * * *`.",
                ),
            ),
            (
                "goal",
                string_schema(
                    "Optional user-facing task goal. Scheduled tasks require prompt or goal.",
                ),
            ),
            (
                "actionType",
                string_schema("Typed action id for policy evaluation, such as greeting."),
            ),
            (
                "ownerScope",
                string_schema("Conversation or owner scope for dedupe, such as manual:redclaw."),
            ),
            (
                "prompt",
                string_schema(
                    "Prompt for scheduled tasks. Scheduled tasks require prompt or goal.",
                ),
            ),
            (
                "objective",
                string_schema("Objective for long-cycle tasks. Required for long_cycle."),
            ),
            (
                "stepPrompt",
                string_schema("Per-round instruction for long-cycle tasks. Required for long_cycle."),
            ),
            (
                "metadata",
                json!({
                    "type": "object",
                    "additionalProperties": true,
                }),
            ),
        ],
        &["name", "actionType", "ownerScope"],
        None,
    )
}

fn redclaw_task_create_input_schema() -> Value {
    object_schema(
        &[
            (
                "previewToken",
                string_schema("Preview token returned by redclaw.task.preview."),
            ),
            (
                "intent",
                json!({
                    "type": "object",
                    "additionalProperties": true,
                }),
            ),
        ],
        &["previewToken", "intent"],
        None,
    )
}

fn redclaw_task_confirm_input_schema() -> Value {
    object_schema(
        &[
            (
                "draftId",
                string_schema("Draft id returned by redclaw.task.create."),
            ),
            ("confirm", bool_schema("Whether to activate the draft.")),
        ],
        &["draftId", "confirm"],
        None,
    )
}

fn redclaw_task_update_input_schema() -> Value {
    object_schema(
        &[
            (
                "jobDefinitionId",
                string_schema("Target job definition id."),
            ),
            (
                "patch",
                json!({
                    "type": "object",
                    "additionalProperties": true,
                }),
            ),
            ("reason", string_schema("Required reason for the update.")),
        ],
        &["jobDefinitionId", "patch", "reason"],
        None,
    )
}

fn redclaw_task_cancel_input_schema() -> Value {
    object_schema(
        &[
            (
                "jobDefinitionId",
                string_schema("Target job definition id."),
            ),
            ("reason", string_schema("Optional cancellation reason.")),
            (
                "deleteSource",
                bool_schema("Set true to remove the underlying scheduled or long-cycle task instead of only disabling it."),
            ),
        ],
        &["jobDefinitionId"],
        None,
    )
}

fn redclaw_task_list_input_schema() -> Value {
    object_schema(
        &[
            ("ownerScope", string_schema("Optional owner scope filter.")),
            (
                "includeDrafts",
                bool_schema("Whether to include pending drafts."),
            ),
        ],
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

fn tools_search_input_schema() -> Value {
    object_schema(
        &[
            (
                "query",
                string_schema("Free-text action, namespace, or capability query."),
            ),
            (
                "namespace",
                string_schema(
                    "Optional action namespace filter, such as memory, mcp, or cli_runtime.",
                ),
            ),
            ("limit", integer_schema("Maximum actions to return.", 1, 50)),
            (
                "includeDirect",
                json!({
                    "type": "boolean",
                    "description": "Also include direct actions already exposed in this turn."
                }),
            ),
        ],
        &[],
        None,
    )
}

fn team_session_create_input_schema() -> Value {
    object_schema(
        &[
            ("title", string_schema("Collaboration project title.")),
            (
                "objective",
                string_schema("Concrete project objective for the internal team."),
            ),
            (
                "runtimeMode",
                string_schema("Runtime mode for the team session."),
            ),
            (
                "source",
                string_schema("Caller source, for example ai_coordinator."),
            ),
            (
                "metadata",
                json!({ "type": "object", "additionalProperties": true }),
            ),
        ],
        &["objective"],
        Some("Create a Workboard collaboration project for internal runtime agents."),
    )
}

fn team_session_get_input_schema() -> Value {
    object_schema(
        &[
            ("sessionId", string_schema("Collaboration session id.")),
            (
                "mailboxLimit",
                integer_schema("Mailbox message limit.", 1, 500),
            ),
            (
                "reportLimit",
                integer_schema("Progress report limit.", 1, 500),
            ),
        ],
        &["sessionId"],
        None,
    )
}

fn team_member_spawn_input_schema() -> Value {
    object_schema(
        &[
            ("sessionId", string_schema("Collaboration session id.")),
            ("displayName", string_schema("Visible team member name.")),
            ("roleId", string_schema("Stable internal role id.")),
            (
                "capabilities",
                json!({ "type": "array", "items": { "type": "string" } }),
            ),
            (
                "metadata",
                json!({ "type": "object", "additionalProperties": true }),
            ),
        ],
        &["sessionId", "displayName"],
        Some("Create one internal runtime team member. Do not create external ACP/CLI members."),
    )
}

fn team_member_match_input_schema() -> Value {
    object_schema(
        &[
            ("sessionId", string_schema("Collaboration session id.")),
            ("title", string_schema("Short task title.")),
            (
                "objective",
                string_schema("Concrete task objective used to rank members."),
            ),
            (
                "description",
                string_schema("Optional detailed task instructions."),
            ),
            (
                "taskType",
                string_schema("Optional task type such as research, image_generation, review, or planning."),
            ),
            (
                "roleId",
                string_schema("Optional desired role id when the caller already knows the best role."),
            ),
            (
                "requiredCapabilities",
                json!({ "type": "array", "items": { "type": "string" } }),
            ),
            (
                "requiredToolFamilies",
                json!({ "type": "array", "items": { "type": "string" } }),
            ),
            (
                "preferredTasks",
                json!({ "type": "array", "items": { "type": "string" } }),
            ),
            ("limit", integer_schema("Maximum candidates to return.", 1, 20)),
        ],
        &["sessionId"],
        Some("Rank existing internal runtime team members by persisted agent card, capabilities, tool policy, and current load."),
    )
}

fn team_member_rename_input_schema() -> Value {
    object_schema(
        &[
            ("sessionId", string_schema("Collaboration session id.")),
            ("memberId", string_schema("Target member id.")),
            ("displayName", string_schema("New visible member name.")),
            ("roleId", string_schema("Optional new role id.")),
        ],
        &["sessionId", "memberId", "displayName"],
        Some("Rename or retitle one internal runtime team member."),
    )
}

fn team_member_shutdown_input_schema() -> Value {
    object_schema(
        &[
            ("sessionId", string_schema("Collaboration session id.")),
            ("memberId", string_schema("Target member id.")),
            (
                "status",
                string_schema("Final member status, usually offline or suspended."),
            ),
            ("reason", string_schema("Optional shutdown reason.")),
        ],
        &["sessionId", "memberId"],
        Some("Mark one team member offline or suspended without deleting persisted history."),
    )
}

fn team_task_create_input_schema() -> Value {
    object_schema(
        &[
            ("sessionId", string_schema("Collaboration session id.")),
            ("memberId", string_schema("Optional assignee member id.")),
            ("title", string_schema("Task title.")),
            ("objective", string_schema("Task objective.")),
            ("description", string_schema("Detailed task instructions.")),
            ("status", string_schema("Initial Kanban status.")),
            ("priority", integer_schema("Task priority.", 0, 100)),
            (
                "dependsOnTaskIds",
                json!({ "type": "array", "items": { "type": "string" } }),
            ),
            (
                "metadata",
                json!({ "type": "object", "additionalProperties": true }),
            ),
        ],
        &["sessionId", "title"],
        Some("Create one structured task on the team Workboard."),
    )
}

fn team_task_update_input_schema() -> Value {
    object_schema(
        &[
            ("taskId", string_schema("Team task id.")),
            ("memberId", string_schema("New assignee member id.")),
            ("status", string_schema("New Kanban status.")),
            (
                "progressPercent",
                integer_schema("Progress percentage.", 0, 100),
            ),
            ("resultSummary", string_schema("Result summary.")),
            (
                "artifacts",
                json!({ "type": "array", "items": { "type": "object" } }),
            ),
            (
                "metadata",
                json!({ "type": "object", "additionalProperties": true }),
            ),
        ],
        &["taskId"],
        None,
    )
}

fn team_artifact_attach_input_schema() -> Value {
    object_schema(
        &[
            ("sessionId", string_schema("Collaboration session id.")),
            ("memberId", string_schema("Reporting member id.")),
            ("taskId", string_schema("Target task id.")),
            (
                "artifact",
                json!({ "type": "object", "additionalProperties": true }),
            ),
            (
                "artifacts",
                json!({ "type": "array", "items": { "type": "object" } }),
            ),
            (
                "artifactIds",
                json!({ "type": "array", "items": { "type": "string" } }),
            ),
            ("summary", string_schema("Artifact report summary.")),
            (
                "payload",
                json!({ "type": "object", "additionalProperties": true }),
            ),
        ],
        &["sessionId", "memberId", "taskId"],
        Some("Attach artifact metadata to a task and submit an artifact report."),
    )
}

fn team_blocker_raise_input_schema() -> Value {
    object_schema(
        &[
            ("sessionId", string_schema("Collaboration session id.")),
            ("memberId", string_schema("Reporting member id.")),
            ("taskId", string_schema("Blocked task id.")),
            ("blocker", string_schema("Primary blocker summary.")),
            (
                "summary",
                string_schema("Optional detailed blocker summary."),
            ),
            (
                "blockers",
                json!({ "type": "array", "items": { "type": "string" } }),
            ),
            (
                "nextSteps",
                json!({ "type": "array", "items": { "type": "string" } }),
            ),
        ],
        &["sessionId", "memberId", "taskId"],
        Some("Raise a structured blocker report for one team task."),
    )
}

fn team_message_send_input_schema() -> Value {
    object_schema(
        &[
            ("sessionId", string_schema("Collaboration session id.")),
            ("fromMemberId", string_schema("Sender member id.")),
            ("toMemberId", string_schema("Recipient member id.")),
            ("taskId", string_schema("Related task id.")),
            ("subject", string_schema("Message subject.")),
            ("body", string_schema("Message body.")),
            ("messageType", string_schema("Message type.")),
            (
                "payload",
                json!({ "type": "object", "additionalProperties": true }),
            ),
        ],
        &["sessionId", "body"],
        None,
    )
}

fn team_report_request_input_schema() -> Value {
    object_schema(
        &[
            ("sessionId", string_schema("Collaboration session id.")),
            (
                "toMemberId",
                string_schema("Member id to request a report from."),
            ),
            ("taskId", string_schema("Related task id.")),
            ("body", string_schema("Report request message.")),
        ],
        &["sessionId", "toMemberId"],
        None,
    )
}

fn team_report_submit_input_schema() -> Value {
    object_schema(
        &[
            ("sessionId", string_schema("Collaboration session id.")),
            ("memberId", string_schema("Reporting member id.")),
            ("taskId", string_schema("Related task id.")),
            ("summary", string_schema("Progress summary.")),
            ("status", string_schema("Report status.")),
            ("reportType", string_schema("Report type.")),
            ("nextAction", string_schema("Immediate next action.")),
            (
                "nextSteps",
                json!({ "type": "array", "items": { "type": "string" } }),
            ),
            (
                "progressPercent",
                integer_schema("Progress percentage.", 0, 100),
            ),
            (
                "blockers",
                json!({ "type": "array", "items": { "type": "string" } }),
            ),
            (
                "artifacts",
                json!({ "type": "array", "items": { "type": "object" } }),
            ),
        ],
        &["sessionId", "memberId", "summary"],
        None,
    )
}

fn cli_runtime_detect_input_schema() -> Value {
    object_schema(
        &[
            (
                "commands",
                json!({
                    "type": "array",
                    "items": { "type": "string" },
                }),
            ),
            (
                "sessionId",
                string_schema("Optional session id for lineage."),
            ),
            ("taskId", string_schema("Optional task id for lineage.")),
        ],
        &[],
        None,
    )
}

fn cli_runtime_discover_input_schema() -> Value {
    object_schema(
        &[
            (
                "query",
                string_schema("Optional CLI name substring to search in PATH."),
            ),
            (
                "limit",
                integer_schema("Maximum number of discovered commands to return.", 1, 500),
            ),
            (
                "sessionId",
                string_schema("Optional session id for lineage."),
            ),
            ("taskId", string_schema("Optional task id for lineage.")),
        ],
        &[],
        None,
    )
}

fn cli_runtime_inspect_input_schema() -> Value {
    object_schema(
        &[
            ("toolId", string_schema("CLI tool id or executable name.")),
            (
                "id",
                string_schema("Compatibility alias for toolId or command."),
            ),
            (
                "command",
                string_schema("Direct command/executable to inspect."),
            ),
            (
                "executable",
                string_schema("Compatibility alias for the command/executable to inspect."),
            ),
            (
                "name",
                string_schema("Compatibility alias for the command/executable to inspect."),
            ),
        ],
        &[],
        None,
    )
}

fn cli_runtime_execution_mode_schema(description: &str) -> Value {
    json!({
        "type": "string",
        "enum": ["managed", "host_compatible", "unrestricted"],
        "description": description,
    })
}

fn cli_runtime_diagnose_input_schema() -> Value {
    object_schema(
        &[
            ("command", string_schema("CLI executable name to diagnose.")),
            (
                "id",
                string_schema("Compatibility alias for the command/executable to diagnose."),
            ),
            (
                "name",
                string_schema("Compatibility alias for the command/executable to diagnose."),
            ),
            (
                "executable",
                string_schema("Compatibility alias for the command/executable to diagnose."),
            ),
            (
                "environmentId",
                string_schema("Optional target CLI environment id."),
            ),
            (
                "cwd",
                string_schema("Optional working directory for the diagnostic plan."),
            ),
            (
                "executionMode",
                cli_runtime_execution_mode_schema(
                    "Execution safety mode. Defaults to host_compatible.",
                ),
            ),
        ],
        &["command"],
        None,
    )
}

fn cli_runtime_environment_create_input_schema() -> Value {
    object_schema(
        &[
            (
                "scope",
                json!({
                    "type": "string",
                    "enum": ["app-global", "workspace-local", "task-ephemeral"],
                }),
            ),
            (
                "workspaceRoot",
                string_schema("Workspace root for workspace-local scope."),
            ),
            ("taskId", string_schema("Task id for task-ephemeral scope.")),
        ],
        &["scope"],
        None,
    )
}

fn cli_runtime_install_input_schema() -> Value {
    object_schema(
        &[
            (
                "environmentId",
                string_schema(
                    "Optional target CLI environment id. Defaults to app-global when omitted.",
                ),
            ),
            (
                "installMethod",
                json!({
                    "type": "string",
                    "enum": ["manual", "npm", "pnpm", "python", "uv", "cargo", "go", "binary"],
                }),
            ),
            (
                "spec",
                string_schema("Install spec passed to the package manager."),
            ),
            (
                "toolName",
                string_schema("Expected executable name after installation."),
            ),
            (
                "executionMode",
                cli_runtime_execution_mode_schema(
                    "Execution safety mode for the installer command. Defaults to host_compatible.",
                ),
            ),
            (
                "sessionId",
                string_schema("Optional session id for lineage."),
            ),
            ("taskId", string_schema("Optional task id for lineage.")),
            (
                "runtimeId",
                string_schema("Optional runtime id for lineage."),
            ),
        ],
        &["installMethod", "spec"],
        None,
    )
}

fn cli_runtime_execute_input_schema() -> Value {
    object_schema(
        &[
            ("environmentId", string_schema("Target CLI environment id.")),
            (
                "toolId",
                string_schema("Optional tool id or executable name."),
            ),
            (
                "argv",
                json!({
                    "type": "array",
                    "items": { "type": "string" },
                }),
            ),
            ("cwd", string_schema("Working directory for the command.")),
            (
                "sessionId",
                string_schema("Optional session id for lineage."),
            ),
            ("taskId", string_schema("Optional task id for lineage.")),
            (
                "runtimeId",
                string_schema("Optional runtime id for lineage."),
            ),
            (
                "executionMode",
                cli_runtime_execution_mode_schema(
                    "Execution safety mode. Use unrestricted only after explicit user approval.",
                ),
            ),
            ("usePty", bool_schema("Whether to request PTY execution.")),
            (
                "maxChars",
                integer_schema(
                    "Maximum stdout/stderr characters to include in the immediate response.",
                    0,
                    100_000,
                ),
            ),
            (
                "verificationRules",
                json!({
                    "type": "array",
                    "items": { "type": "object", "additionalProperties": true },
                }),
            ),
            (
                "env",
                json!({
                    "type": "object",
                    "additionalProperties": { "type": "string" },
                }),
            ),
        ],
        &["argv"],
        None,
    )
}

fn cli_runtime_execution_get_input_schema() -> Value {
    object_schema(
        &[
            ("executionId", string_schema("CLI execution id.")),
            ("id", string_schema("Compatibility alias for executionId.")),
            (
                "maxChars",
                integer_schema(
                    "Maximum stdout/stderr characters to include from each output stream.",
                    0,
                    100_000,
                ),
            ),
        ],
        &[],
        None,
    )
}

fn cli_runtime_verify_input_schema() -> Value {
    object_schema(
        &[
            ("executionId", string_schema("CLI execution id.")),
            (
                "rules",
                json!({
                    "type": "array",
                    "items": { "type": "object", "additionalProperties": true },
                }),
            ),
        ],
        &["executionId", "rules"],
        None,
    )
}

fn cli_runtime_escalation_approve_input_schema() -> Value {
    object_schema(
        &[
            ("escalationId", string_schema("Escalation request id.")),
            (
                "scope",
                json!({
                    "type": "string",
                    "enum": ["once", "session", "always"],
                }),
            ),
        ],
        &["escalationId", "scope"],
        None,
    )
}

fn cli_runtime_escalation_deny_input_schema() -> Value {
    object_schema(
        &[
            ("escalationId", string_schema("Escalation request id.")),
            ("reason", string_schema("Optional denial reason.")),
        ],
        &["escalationId"],
        None,
    )
}

fn mcp_list_input_schema() -> Value {
    no_payload_schema()
}

fn mcp_server_target_input_schema() -> Value {
    object_schema(
        &[
            ("serverId", string_schema("Target MCP server id.")),
            ("id", string_schema("Alias for serverId.")),
            (
                "server",
                json!({
                    "type": "object",
                    "additionalProperties": true,
                    "description": "Inline MCP server record when it is not saved yet."
                }),
            ),
        ],
        &[],
        None,
    )
}

fn mcp_save_input_schema() -> Value {
    object_schema(
        &[
            (
                "server",
                json!({
                    "type": "object",
                    "additionalProperties": true,
                    "description": "Single MCP server record to add or update without removing other saved servers."
                }),
            ),
            (
                "servers",
                json!({
                    "type": "array",
                    "items": {
                        "type": "object",
                        "additionalProperties": true
                    },
                    "description": "Complete MCP server records to save as the active RedBox MCP configuration."
                }),
            ),
        ],
        &[],
        None,
    )
}

fn mcp_call_input_schema() -> Value {
    object_schema(
        &[
            ("serverId", string_schema("Target MCP server id.")),
            (
                "server",
                json!({
                    "type": "object",
                    "additionalProperties": true,
                    "description": "Inline MCP server record when it is not saved yet."
                }),
            ),
            ("method", string_schema("Method name.")),
            (
                "params",
                json!({
                    "type": "object",
                    "additionalProperties": true,
                }),
            ),
            (
                "sessionId",
                string_schema("Optional RedBox runtime session id."),
            ),
        ],
        &["method"],
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
    let max_batch_items = 6;
    object_schema(
        &[
            ("prompt", string_schema("Image generation prompt.")),
            (
                "count",
                integer_schema("Number of images to generate.", 1, max_batch_items),
            ),
            (
                "aspectRatio",
                image_aspect_ratio_schema(
                    "Required when the user asks for a specific image ratio. Supported values: 1:1 square, 3:4 portrait/Xiaohongshu card, 4:3 landscape, 9:16 vertical story, 16:9 wide.",
                ),
            ),
            (
                "size",
                image_size_schema(
                    "Optional explicit output size. Prefer aspectRatio unless the user requests exact pixels.",
                ),
            ),
            (
                "quality",
                image_quality_schema("Optional image quality hint."),
            ),
            ("title", string_schema("Optional media asset title.")),
            ("projectId", string_schema("Optional media project id.")),
            ("model", string_schema("Optional model override.")),
            (
                "planConfirmed",
                bool_schema("Whether the user has confirmed the multi-image plan."),
            ),
            (
                "planExecutionMode",
                json!({
                    "type": "string",
                    "description": "How a multi-image plan is allowed to proceed. Use `user_confirmed` by default. `redclaw_auto_execute` is only valid inside RedClaw for coordinated multi-image batches."
                }),
            ),
            (
                "sequenceGoal",
                string_schema("Ordering goal for the multi-image batch."),
            ),
            (
                "sharedStyleGuide",
                string_schema("Shared style anchor for a coordinated multi-image batch."),
            ),
            (
                "referenceImages",
                json!({
                    "type": "array",
                    "items": { "type": "string" },
                    "maxItems": 5,
                }),
            ),
            (
                "imagePlanItems",
                json!({
                    "type": "array",
                    "maxItems": max_batch_items,
                    "items": {
                        "type": "object",
                        "properties": {
                            "title": { "type": "string" },
                            "prompt": { "type": "string" },
                            "copy": { "type": "string" },
                            "compiledPrompt": { "type": "string" }
                        },
                        "additionalProperties": false
                    }
                }),
            ),
            ("generationMode", string_schema("Generation mode.")),
            (
                "waitForCompletion",
                bool_schema(
                    "Whether to block until the generation job completes. Defaults to false.",
                ),
            ),
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
            (
                "waitForCompletion",
                bool_schema(
                    "Whether to block until the generation job completes. Defaults to false.",
                ),
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

fn file_system_output_schema() -> Value {
    ok_output_schema(json!({
        "type": "object",
        "additionalProperties": true
    }))
}

fn fs_workspace_list_input_schema() -> Value {
    object_schema(
        &[
            (
                "path",
                string_schema("Workspace-relative directory path to inspect."),
            ),
            ("limit", integer_schema("Maximum entries to list.", 1, 200)),
        ],
        &["path"],
        None,
    )
}

fn fs_workspace_read_input_schema() -> Value {
    object_schema(
        &[
            (
                "path",
                string_schema("Workspace-relative file path to read."),
            ),
            (
                "maxChars",
                integer_schema("Maximum response characters.", 200, 20_000),
            ),
        ],
        &["path"],
        None,
    )
}

fn fs_workspace_search_input_schema() -> Value {
    object_schema(
        &[
            ("query", string_schema("Free-text query to search for.")),
            (
                "path",
                string_schema("Optional workspace-relative directory or file to scope the search."),
            ),
            (
                "pattern",
                string_schema("Optional workspace-relative glob pattern."),
            ),
            (
                "limit",
                integer_schema("Maximum matches to return.", 1, 400),
            ),
            (
                "snippetChars",
                integer_schema("Maximum snippet characters per hit.", 80, 800),
            ),
        ],
        &["query"],
        None,
    )
}

fn fs_knowledge_list_input_schema() -> Value {
    object_schema(
        &[
            (
                "advisorId",
                string_schema("Optional advisor id when not bound by session."),
            ),
            (
                "memberId",
                string_schema("Optional collaboration member id; when provided, knowledge resolves to that member's bound advisor or document source."),
            ),
            (
                "collabMemberId",
                string_schema("Alias for memberId."),
            ),
            (
                "sourceId",
                string_schema("Optional registered document source id to search instead of advisor/shared knowledge."),
            ),
            (
                "rootPath",
                string_schema("Optional registered document source root path when sourceId is not available."),
            ),
            (
                "path",
                string_schema("Optional source-relative path to list."),
            ),
            (
                "pattern",
                string_schema("Optional source-relative glob pattern."),
            ),
            (
                "limit",
                integer_schema("Maximum matches to return.", 1, 200),
            ),
        ],
        &[],
        None,
    )
}

fn fs_knowledge_search_input_schema() -> Value {
    object_schema(
        &[
            (
                "advisorId",
                string_schema("Optional advisor id when not bound by session."),
            ),
            (
                "memberId",
                string_schema("Optional collaboration member id; when provided, knowledge resolves to that member's bound advisor or document source."),
            ),
            (
                "collabMemberId",
                string_schema("Alias for memberId."),
            ),
            (
                "sourceId",
                string_schema("Optional registered document source id to search instead of advisor/shared knowledge."),
            ),
            (
                "rootPath",
                string_schema("Optional registered document source root path when sourceId is not available."),
            ),
            (
                "path",
                string_schema("Optional source-relative path to scope the search."),
            ),
            (
                "pattern",
                string_schema("Optional source-relative glob pattern."),
            ),
            ("query", string_schema("Free-text query to search for.")),
            (
                "retrievalMode",
                string_schema("Optional retrieval mode: `hybrid` (default) or `lexical`."),
            ),
            (
                "limit",
                integer_schema("Maximum matches to return.", 1, 100),
            ),
            (
                "snippetChars",
                integer_schema("Maximum snippet characters per hit.", 80, 800),
            ),
        ],
        &["query"],
        None,
    )
}

fn fs_knowledge_read_input_schema() -> Value {
    object_schema(
        &[
            (
                "advisorId",
                string_schema("Optional advisor id when not bound by session."),
            ),
            (
                "memberId",
                string_schema("Optional collaboration member id; when provided, knowledge resolves to that member's bound advisor or document source."),
            ),
            (
                "collabMemberId",
                string_schema("Alias for memberId."),
            ),
            (
                "sourceId",
                string_schema("Optional registered document source id to read instead of advisor/shared knowledge."),
            ),
            (
                "rootPath",
                string_schema("Optional registered document source root path when sourceId is not available."),
            ),
            (
                "blockId",
                string_schema("Optional indexed block id returned by knowledge.search."),
            ),
            (
                "anchorId",
                string_schema("Optional citation anchor id returned by knowledge.search."),
            ),
            ("path", string_schema("Source-relative file path to read.")),
            ("offset", integer_schema("0-based line offset.", 0, 100_000)),
            ("limit", integer_schema("Maximum lines to read.", 1, 400)),
            (
                "maxChars",
                integer_schema("Maximum response characters.", 200, 20_000),
            ),
            (
                "maxBytes",
                integer_schema("Maximum media bytes for knowledge.attach.", 1, 20 * 1024 * 1024),
            ),
        ],
        &[],
        None,
    )
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

fn virtual_path_schema(description: &str) -> Value {
    json!({
        "type": "string",
        "description": description,
        "examples": [
            "workspace://README.md",
            "knowledge://",
            "profiles://creator_profile",
            "manuscripts://current",
            "editor://current/script",
            "editor://current/remotion"
        ]
    })
}

fn redbox_resource_schema() -> Value {
    redbox_resource_schema_for_actions(&[])
}

fn redbox_resource_schema_for_actions(descriptors: &[ActionDescriptor]) -> Value {
    let resources = redbox_resource_enum_for_actions(descriptors);
    json!({
        "type": "string",
        "enum": resources,
        "description": "Product resource family. Prefer Read/List/Search/Write for simple resource access; use Redbox for product operations with side effects or workflow semantics."
    })
}

fn redbox_operation_schema() -> Value {
    redbox_operation_schema_for_actions(&[])
}

fn redbox_operation_schema_for_actions(descriptors: &[ActionDescriptor]) -> Value {
    let operations = redbox_operation_enum_for_actions(descriptors);
    json!({
        "type": "string",
        "enum": operations,
        "description": "Generic operation for the selected resource. The host maps this stable verb to the existing RedBox action contract."
    })
}

fn redbox_resource_enum_for_actions(descriptors: &[ActionDescriptor]) -> Vec<&'static str> {
    let mut resources = if descriptors.is_empty() {
        [
            "manuscript",
            "profile",
            "memory",
            "subject",
            "image",
            "video",
            "web",
            "task",
            "editor",
            "skill",
            "mcp",
            "runtime",
            "cli_runtime",
            "tools",
        ]
        .into_iter()
        .collect::<Vec<_>>()
    } else {
        let mut seen = std::collections::BTreeSet::<&'static str>::new();
        for descriptor in descriptors {
            if let Some(resource) = redbox_resource_for_action(descriptor.action) {
                seen.insert(resource);
            }
        }
        seen.into_iter().collect::<Vec<_>>()
    };
    if resources.is_empty() {
        resources.push("runtime");
    }
    resources
}

fn redbox_operation_enum_for_actions(descriptors: &[ActionDescriptor]) -> Vec<&'static str> {
    let mut operations = if descriptors.is_empty() {
        [
            "list", "get", "search", "create", "update", "delete", "run", "generate", "export",
            "confirm", "cancel", "resume", "install", "verify",
        ]
        .into_iter()
        .collect::<Vec<_>>()
    } else {
        let mut seen = std::collections::BTreeSet::<&'static str>::new();
        for descriptor in descriptors {
            if let Some(operation) = redbox_operation_for_action(descriptor.action) {
                seen.insert(operation);
            }
        }
        seen.into_iter().collect::<Vec<_>>()
    };
    if operations.is_empty() {
        operations.push("get");
    }
    operations
}

fn redbox_resource_for_action(action: &str) -> Option<&'static str> {
    let namespace = action.split('.').next().unwrap_or(action);
    match namespace {
        "manuscripts" => Some("manuscript"),
        "memory" => Some("memory"),
        "subjects" => Some("subject"),
        "image" => Some("image"),
        "video" => Some("video"),
        "web" => Some("web"),
        "skills" => Some("skill"),
        "mcp" => Some("mcp"),
        "runtime" | "team" => Some("runtime"),
        "cli_runtime" => Some("cli_runtime"),
        "tools" => Some("tools"),
        "redclaw" if action.starts_with("redclaw.profile.") => Some("profile"),
        "redclaw" if action.starts_with("redclaw.task.") => Some("task"),
        _ => None,
    }
}

fn redbox_operation_for_action(action: &str) -> Option<&'static str> {
    let verb = action.rsplit('.').next().unwrap_or(action);
    match verb {
        "list" => Some("list"),
        "search" => Some("search"),
        "get" | "read" | "fetch" | "readCurrent" | "bundle" | "stats" | "query"
        | "getCheckpoints" | "getToolResults" | "sessions" | "oauthStatus" => Some("get"),
        "create" | "createProject" | "preview" | "add" | "spawn" | "send" | "request" => {
            Some("create")
        }
        "update" | "writeCurrent" | "submit" => Some("update"),
        "delete" | "disconnect" | "disconnectAll" | "deny" => Some("delete"),
        "cancel" => Some("cancel"),
        "resume" => Some("resume"),
        "confirm" | "approve" => Some("confirm"),
        "invoke" | "call" | "execute" => Some("run"),
        "generate" => Some("generate"),
        "install" | "save" | "importLocal" => Some("install"),
        "verify" | "diagnose" | "inspect" | "detect" | "discover" | "discoverLocal" | "test" => {
            Some("verify")
        }
        "listTools" | "listResources" | "listResourceTemplates" => Some("list"),
        _ => None,
    }
}

fn redbox_tool_schema(descriptors: Option<&[ActionDescriptor]>) -> Value {
    let descriptors = descriptors.unwrap_or(&[]);
    let resource_schema = if descriptors.is_empty() {
        redbox_resource_schema()
    } else {
        redbox_resource_schema_for_actions(descriptors)
    };
    let operation_schema = if descriptors.is_empty() {
        redbox_operation_schema()
    } else {
        redbox_operation_schema_for_actions(descriptors)
    };
    json!({
        "type": "function",
        "function": {
            "name": "Redbox",
            "description": REDBOX_DESCRIPTION,
            "parameters": {
                "type": "object",
                "properties": {
                    "resource": resource_schema,
                    "operation": operation_schema,
                    "id": { "type": "string", "description": "Optional target id, such as subject id, draft id, job id, MCP server id, or runtime task id." },
                    "input": redbox_input_schema()
                },
                "required": ["resource", "operation"],
                "additionalProperties": false
            }
        }
    })
}

fn redbox_input_schema() -> Value {
    json!({
        "type": "object",
        "description": "Structured operation input. For image generation, put prompt/count/aspectRatio/size/quality/referenceImages here; do not hide the requested ratio inside prompt text only.",
        "properties": {
            "prompt": { "type": "string", "description": "Generation or operation prompt." },
            "count": { "type": "integer", "minimum": 1, "maximum": 6, "description": "Number of images or generated items." },
            "aspectRatio": image_aspect_ratio_schema("Image output ratio. Required for image generation when the user specifies square/portrait/landscape/vertical/wide or a ratio like 3:4."),
            "ratio": image_aspect_ratio_schema("Alias for aspectRatio; prefer aspectRatio in new calls."),
            "size": image_size_schema("Optional explicit output size. Prefer aspectRatio unless exact pixels were requested."),
            "quality": image_quality_schema("Optional image quality hint."),
            "generationMode": {
                "type": "string",
                "enum": ["text-to-image", "reference-guided", "image-to-image", "text-to-video", "first-last-frame", "continuation"],
                "description": "Media generation mode."
            },
            "referenceImages": {
                "type": "array",
                "items": { "type": "string" },
                "maxItems": 5,
                "description": "Reference image URLs, data URLs, asset ids, or local paths."
            },
            "planConfirmed": { "type": "boolean", "description": "Whether the user approved a multi-image plan." },
            "planExecutionMode": { "type": "string", "description": "Use user_confirmed by default; redclaw_auto_execute is only for controlled RedClaw batches." },
            "sequenceGoal": { "type": "string", "description": "Ordering goal for a multi-image batch." },
            "sharedStyleGuide": { "type": "string", "description": "Shared style anchor for a coordinated image batch." },
            "imagePlanItems": {
                "type": "array",
                "maxItems": 6,
                "items": {
                    "type": "object",
                    "properties": {
                        "title": { "type": "string" },
                        "prompt": { "type": "string" },
                        "copy": { "type": "string" },
                        "compiledPrompt": { "type": "string" }
                    },
                    "additionalProperties": false
                }
            }
        },
        "additionalProperties": true
    })
}

const APP_CLI_ACTIONS: &[ActionDescriptor] = &[
    ActionDescriptor {
        action: "tools.search",
        namespace: "tools",
        description: "Search deferred app_cli actions available to the current session.",
        input_schema: tools_search_input_schema,
        output_schema: generic_state_output_schema,
        mutating: false,
        concurrency_safe: true,
        runtime_modes: ALL_APP_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
    ActionDescriptor {
        action: "web.fetch",
        namespace: "web",
        description: "Fetch a user-provided public http/https URL and return readable page text. Use this for explicit URLs instead of bash curl. This does not search the web.",
        input_schema: web_fetch_input_schema,
        output_schema: generic_state_output_schema,
        mutating: false,
        concurrency_safe: true,
        runtime_modes: ALL_APP_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
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
        action: "memory.recall",
        namespace: "memory",
        description: "Recall compact durable memory entries for runtime context with ranking metadata.",
        input_schema: memory_recall_input_schema,
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
        action: "memory.update",
        namespace: "memory",
        description: "Update a durable memory entry while preserving history.",
        input_schema: memory_update_input_schema,
        output_schema: memory_output_schema,
        mutating: true,
        concurrency_safe: false,
        runtime_modes: REDCLAW_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
    ActionDescriptor {
        action: "memory.archive",
        namespace: "memory",
        description: "Archive a durable memory entry while preserving history.",
        input_schema: memory_archive_input_schema,
        output_schema: memory_output_schema,
        mutating: true,
        concurrency_safe: false,
        runtime_modes: REDCLAW_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
    ActionDescriptor {
        action: "memory.rebuildIndex",
        namespace: "memory",
        description: "Rebuild the local durable memory BM25 index from the memory catalog.",
        input_schema: memory_rebuild_index_input_schema,
        output_schema: memory_output_schema,
        mutating: true,
        concurrency_safe: false,
        runtime_modes: REDCLAW_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
    ActionDescriptor {
        action: "memory.diagnostics",
        namespace: "memory",
        description: "Inspect durable memory index status and retrieval engine diagnostics.",
        input_schema: memory_diagnostics_input_schema,
        output_schema: memory_output_schema,
        mutating: false,
        concurrency_safe: true,
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
        visibility: ActionVisibility::CompatOnly,
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
        visibility: ActionVisibility::CompatOnly,
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
        visibility: ActionVisibility::CompatOnly,
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
        visibility: ActionVisibility::CompatOnly,
    },
    ActionDescriptor {
        action: "redclaw.task.preview",
        namespace: "redclaw.task",
        description: "Preview a RedClaw business task definition before creation. Use this for scheduled or long-cycle user tasks, not internal runtime.tasks.*. Scheduled tasks should include cron plus prompt or goal.",
        input_schema: redclaw_task_preview_input_schema,
        output_schema: generic_state_output_schema,
        mutating: false,
        concurrency_safe: true,
        runtime_modes: REDCLAW_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
    ActionDescriptor {
        action: "redclaw.task.create",
        namespace: "redclaw.task",
        description: "Create a pending RedClaw task draft from a validated preview token returned by redclaw.task.preview.",
        input_schema: redclaw_task_create_input_schema,
        output_schema: generic_state_output_schema,
        mutating: true,
        concurrency_safe: false,
        runtime_modes: REDCLAW_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
    ActionDescriptor {
        action: "redclaw.task.confirm",
        namespace: "redclaw.task",
        description: "Confirm or discard a pending RedClaw task draft. Use after redclaw.task.create.",
        input_schema: redclaw_task_confirm_input_schema,
        output_schema: generic_state_output_schema,
        mutating: true,
        concurrency_safe: false,
        runtime_modes: REDCLAW_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
    ActionDescriptor {
        action: "redclaw.task.update",
        namespace: "redclaw.task",
        description: "Update an existing RedClaw task definition with an explicit reason.",
        input_schema: redclaw_task_update_input_schema,
        output_schema: generic_state_output_schema,
        mutating: true,
        concurrency_safe: false,
        runtime_modes: REDCLAW_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
    ActionDescriptor {
        action: "redclaw.task.cancel",
        namespace: "redclaw.task",
        description: "Disable, discard, or delete a RedClaw task definition. Set deleteSource=true when the user explicitly asks to delete the task.",
        input_schema: redclaw_task_cancel_input_schema,
        output_schema: generic_state_output_schema,
        mutating: true,
        concurrency_safe: false,
        runtime_modes: REDCLAW_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
    ActionDescriptor {
        action: "redclaw.task.list",
        namespace: "redclaw.task",
        description: "List RedClaw task definitions with policy and latest execution state.",
        input_schema: redclaw_task_list_input_schema,
        output_schema: generic_state_output_schema,
        mutating: false,
        concurrency_safe: true,
        runtime_modes: REDCLAW_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
    ActionDescriptor {
        action: "redclaw.task.stats",
        namespace: "redclaw.task",
        description: "Read RedClaw task definition and execution counters.",
        input_schema: no_payload_schema,
        output_schema: generic_state_output_schema,
        mutating: false,
        concurrency_safe: true,
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
        action: "team.session.create",
        namespace: "team.session",
        description: "Create a Workboard collaboration project for internal runtime agents when the user asks for team collaboration, multi-role execution, or ongoing progress reporting.",
        input_schema: team_session_create_input_schema,
        output_schema: runtime_output_schema,
        mutating: true,
        concurrency_safe: false,
        runtime_modes: ALL_APP_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
    ActionDescriptor {
        action: "team.session.list",
        namespace: "team.session",
        description: "List Workboard collaboration projects.",
        input_schema: no_payload_schema,
        output_schema: runtime_output_schema,
        mutating: false,
        concurrency_safe: true,
        runtime_modes: ALL_APP_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
    ActionDescriptor {
        action: "team.session.get",
        namespace: "team.session",
        description: "Read one Workboard collaboration project snapshot with members, tasks, mailbox, and reports.",
        input_schema: team_session_get_input_schema,
        output_schema: runtime_output_schema,
        mutating: false,
        concurrency_safe: true,
        runtime_modes: ALL_APP_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
    ActionDescriptor {
        action: "team.member.spawn",
        namespace: "team.member",
        description: "Create one internal runtime team member role inside a Workboard collaboration project. Never use this for external ACP/CLI agents.",
        input_schema: team_member_spawn_input_schema,
        output_schema: runtime_output_schema,
        mutating: true,
        concurrency_safe: false,
        runtime_modes: ALL_APP_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
    ActionDescriptor {
        action: "team.member.match",
        namespace: "team.member",
        description: "Rank existing team members for a task using their persisted agent cards, capabilities, tool policy, and current load.",
        input_schema: team_member_match_input_schema,
        output_schema: runtime_output_schema,
        mutating: false,
        concurrency_safe: true,
        runtime_modes: ALL_APP_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
    ActionDescriptor {
        action: "team.member.rename",
        namespace: "team.member",
        description: "Rename or retitle one internal team member while preserving its persisted identity and history.",
        input_schema: team_member_rename_input_schema,
        output_schema: runtime_output_schema,
        mutating: true,
        concurrency_safe: false,
        runtime_modes: ALL_APP_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
    ActionDescriptor {
        action: "team.member.shutdown",
        namespace: "team.member",
        description: "Mark one internal team member offline or suspended without deleting its persisted history.",
        input_schema: team_member_shutdown_input_schema,
        output_schema: runtime_output_schema,
        mutating: true,
        concurrency_safe: false,
        runtime_modes: ALL_APP_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
    ActionDescriptor {
        action: "team.members.list",
        namespace: "team.member",
        description: "List internal team members in a Workboard collaboration project.",
        input_schema: team_session_get_input_schema,
        output_schema: runtime_output_schema,
        mutating: false,
        concurrency_safe: true,
        runtime_modes: ALL_APP_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
    ActionDescriptor {
        action: "team.task.create",
        namespace: "team.task",
        description: "Create a structured task for an internal team member on the Workboard Kanban.",
        input_schema: team_task_create_input_schema,
        output_schema: runtime_output_schema,
        mutating: true,
        concurrency_safe: false,
        runtime_modes: ALL_APP_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
    ActionDescriptor {
        action: "team.task.update",
        namespace: "team.task",
        description: "Update team task owner, status, progress, result summary, blockers, or artifacts.",
        input_schema: team_task_update_input_schema,
        output_schema: runtime_output_schema,
        mutating: true,
        concurrency_safe: false,
        runtime_modes: ALL_APP_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
    ActionDescriptor {
        action: "team.task.list",
        namespace: "team.task",
        description: "List team tasks in one Workboard collaboration project.",
        input_schema: team_session_get_input_schema,
        output_schema: runtime_output_schema,
        mutating: false,
        concurrency_safe: true,
        runtime_modes: ALL_APP_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
    ActionDescriptor {
        action: "team.message.send",
        namespace: "team.message",
        description: "Send a durable mailbox message between internal team members or from the coordinator.",
        input_schema: team_message_send_input_schema,
        output_schema: runtime_output_schema,
        mutating: true,
        concurrency_safe: false,
        runtime_modes: ALL_APP_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
    ActionDescriptor {
        action: "team.report.request",
        namespace: "team.report",
        description: "Request a progress report from an internal team member through the mailbox.",
        input_schema: team_report_request_input_schema,
        output_schema: runtime_output_schema,
        mutating: true,
        concurrency_safe: false,
        runtime_modes: ALL_APP_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
    ActionDescriptor {
        action: "team.report.submit",
        namespace: "team.report",
        description: "Submit a structured progress, blocker, completion, or artifact report for a team member.",
        input_schema: team_report_submit_input_schema,
        output_schema: runtime_output_schema,
        mutating: true,
        concurrency_safe: false,
        runtime_modes: ALL_APP_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
    ActionDescriptor {
        action: "team.artifact.attach",
        namespace: "team.artifact",
        description: "Attach artifact metadata to a team task and submit an artifact progress report.",
        input_schema: team_artifact_attach_input_schema,
        output_schema: runtime_output_schema,
        mutating: true,
        concurrency_safe: false,
        runtime_modes: ALL_APP_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
    ActionDescriptor {
        action: "team.blocker.raise",
        namespace: "team.blocker",
        description: "Raise a structured blocker report for one team task.",
        input_schema: team_blocker_raise_input_schema,
        output_schema: runtime_output_schema,
        mutating: true,
        concurrency_safe: false,
        runtime_modes: ALL_APP_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
    ActionDescriptor {
        action: "cli_runtime.detect",
        namespace: "cli_runtime",
        description: "Detect available CLI tools from the host PATH and managed environments.",
        input_schema: cli_runtime_detect_input_schema,
        output_schema: generic_state_output_schema,
        mutating: false,
        concurrency_safe: true,
        runtime_modes: ALL_APP_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
    ActionDescriptor {
        action: "cli_runtime.discover",
        namespace: "cli_runtime",
        description: "Enumerate CLI commands visible from the current host PATH, with optional query filtering.",
        input_schema: cli_runtime_discover_input_schema,
        output_schema: generic_state_output_schema,
        mutating: false,
        concurrency_safe: true,
        runtime_modes: ALL_APP_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
    ActionDescriptor {
        action: "cli_runtime.inspect",
        namespace: "cli_runtime",
        description: "Inspect one host CLI executable and refresh its detection record. Use this instead of bash which/type/command -v.",
        input_schema: cli_runtime_inspect_input_schema,
        output_schema: generic_state_output_schema,
        mutating: false,
        concurrency_safe: true,
        runtime_modes: ALL_APP_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
    ActionDescriptor {
        action: "cli_runtime.diagnose",
        namespace: "cli_runtime",
        description: "Diagnose how one CLI command will resolve and which sandbox profile will be used.",
        input_schema: cli_runtime_diagnose_input_schema,
        output_schema: generic_state_output_schema,
        mutating: false,
        concurrency_safe: true,
        runtime_modes: ALL_APP_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
    ActionDescriptor {
        action: "cli_runtime.environment.list",
        namespace: "cli_runtime.environment",
        description: "List managed CLI runtime environments.",
        input_schema: no_payload_schema,
        output_schema: generic_state_output_schema,
        mutating: false,
        concurrency_safe: true,
        runtime_modes: ALL_APP_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
    ActionDescriptor {
        action: "cli_runtime.environment.create",
        namespace: "cli_runtime.environment",
        description: "Create or hydrate a managed CLI runtime environment.",
        input_schema: cli_runtime_environment_create_input_schema,
        output_schema: generic_state_output_schema,
        mutating: true,
        concurrency_safe: false,
        runtime_modes: ALL_APP_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
    ActionDescriptor {
        action: "cli_runtime.install",
        namespace: "cli_runtime",
        description: "Install one CLI tool into a managed environment.",
        input_schema: cli_runtime_install_input_schema,
        output_schema: generic_state_output_schema,
        mutating: true,
        concurrency_safe: false,
        runtime_modes: ALL_APP_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
    ActionDescriptor {
        action: "cli_runtime.execute",
        namespace: "cli_runtime",
        description: "Execute one real host CLI command through the managed runtime control plane. Use argv as an array, for example {\"argv\":[\"lark-cli\",\"--version\"]}. Do not use bash for this.",
        input_schema: cli_runtime_execute_input_schema,
        output_schema: generic_state_output_schema,
        mutating: true,
        concurrency_safe: false,
        runtime_modes: ALL_APP_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
    ActionDescriptor {
        action: "cli_runtime.execution.get",
        namespace: "cli_runtime.execution",
        description: "Read one CLI execution snapshot, including stdout/stderr tails. Use this instead of reading log files directly.",
        input_schema: cli_runtime_execution_get_input_schema,
        output_schema: generic_state_output_schema,
        mutating: false,
        concurrency_safe: true,
        runtime_modes: ALL_APP_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
    ActionDescriptor {
        action: "cli_runtime.verify",
        namespace: "cli_runtime",
        description: "Run structured verification rules against one finished CLI execution.",
        input_schema: cli_runtime_verify_input_schema,
        output_schema: generic_state_output_schema,
        mutating: true,
        concurrency_safe: false,
        runtime_modes: ALL_APP_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
    ActionDescriptor {
        action: "cli_runtime.escalation.approve",
        namespace: "cli_runtime.escalation",
        description: "Approve one pending CLI escalation request.",
        input_schema: cli_runtime_escalation_approve_input_schema,
        output_schema: generic_state_output_schema,
        mutating: true,
        concurrency_safe: false,
        runtime_modes: ALL_APP_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
    ActionDescriptor {
        action: "cli_runtime.escalation.deny",
        namespace: "cli_runtime.escalation",
        description: "Deny one pending CLI escalation request.",
        input_schema: cli_runtime_escalation_deny_input_schema,
        output_schema: generic_state_output_schema,
        mutating: true,
        concurrency_safe: false,
        runtime_modes: ALL_APP_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
    ActionDescriptor {
        action: "mcp.list",
        namespace: "mcp",
        description: "List saved MCP server records and active sessions. Use this first when the user asks whether MCP is configured.",
        input_schema: mcp_list_input_schema,
        output_schema: generic_state_output_schema,
        mutating: false,
        concurrency_safe: true,
        runtime_modes: ALL_APP_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
    ActionDescriptor {
        action: "mcp.sessions",
        namespace: "mcp",
        description: "List active MCP transport sessions.",
        input_schema: mcp_list_input_schema,
        output_schema: generic_state_output_schema,
        mutating: false,
        concurrency_safe: true,
        runtime_modes: ALL_APP_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
    ActionDescriptor {
        action: "mcp.discoverLocal",
        namespace: "mcp",
        description: "Discover MCP server configs already present on this computer, such as Codex or Claude Desktop config files.",
        input_schema: mcp_list_input_schema,
        output_schema: generic_state_output_schema,
        mutating: false,
        concurrency_safe: true,
        runtime_modes: ALL_APP_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
    ActionDescriptor {
        action: "mcp.importLocal",
        namespace: "mcp",
        description: "Import locally discovered MCP server configs into RedBox and sync the MCP manager.",
        input_schema: mcp_list_input_schema,
        output_schema: generic_state_output_schema,
        mutating: true,
        concurrency_safe: false,
        runtime_modes: ALL_APP_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
    ActionDescriptor {
        action: "mcp.save",
        namespace: "mcp",
        description: "Save MCP server configuration. Pass server to add/update one record, or servers to replace the complete active list.",
        input_schema: mcp_save_input_schema,
        output_schema: generic_state_output_schema,
        mutating: true,
        concurrency_safe: false,
        runtime_modes: ALL_APP_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
    ActionDescriptor {
        action: "mcp.test",
        namespace: "mcp",
        description: "Probe one MCP server by initializing it and checking basic connectivity.",
        input_schema: mcp_server_target_input_schema,
        output_schema: generic_state_output_schema,
        mutating: false,
        concurrency_safe: false,
        runtime_modes: ALL_APP_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
    ActionDescriptor {
        action: "mcp.call",
        namespace: "mcp",
        description: "Call an allowed low-level MCP diagnostic method such as tools/list, resources/list, resources/read, or tools/call.",
        input_schema: mcp_call_input_schema,
        output_schema: generic_state_output_schema,
        mutating: true,
        concurrency_safe: false,
        runtime_modes: ALL_APP_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
    ActionDescriptor {
        action: "mcp.listTools",
        namespace: "mcp",
        description: "List tools exposed by one MCP server.",
        input_schema: mcp_server_target_input_schema,
        output_schema: generic_state_output_schema,
        mutating: false,
        concurrency_safe: true,
        runtime_modes: ALL_APP_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
    ActionDescriptor {
        action: "mcp.listResources",
        namespace: "mcp",
        description: "List resources exposed by one MCP server.",
        input_schema: mcp_server_target_input_schema,
        output_schema: generic_state_output_schema,
        mutating: false,
        concurrency_safe: true,
        runtime_modes: ALL_APP_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
    ActionDescriptor {
        action: "mcp.listResourceTemplates",
        namespace: "mcp",
        description: "List resource templates exposed by one MCP server.",
        input_schema: mcp_server_target_input_schema,
        output_schema: generic_state_output_schema,
        mutating: false,
        concurrency_safe: true,
        runtime_modes: ALL_APP_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
    ActionDescriptor {
        action: "mcp.disconnect",
        namespace: "mcp",
        description: "Disconnect one MCP server session.",
        input_schema: mcp_server_target_input_schema,
        output_schema: generic_state_output_schema,
        mutating: true,
        concurrency_safe: false,
        runtime_modes: ALL_APP_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
    ActionDescriptor {
        action: "mcp.disconnectAll",
        namespace: "mcp",
        description: "Disconnect all active MCP server sessions.",
        input_schema: mcp_list_input_schema,
        output_schema: generic_state_output_schema,
        mutating: true,
        concurrency_safe: false,
        runtime_modes: ALL_APP_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
    ActionDescriptor {
        action: "mcp.oauthStatus",
        namespace: "mcp",
        description: "Read OAuth connection metadata for one MCP server.",
        input_schema: mcp_server_target_input_schema,
        output_schema: generic_state_output_schema,
        mutating: false,
        concurrency_safe: true,
        runtime_modes: ALL_APP_RUNTIME_MODES,
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
        concurrency_safe: true,
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
        concurrency_safe: true,
        runtime_modes: REDCLAW_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
];

const REDBOX_FS_ACTIONS: &[ActionDescriptor] = &[
    ActionDescriptor {
        action: "workspace.list",
        namespace: "workspace",
        description: "List entries inside one workspace-relative directory.",
        input_schema: fs_workspace_list_input_schema,
        output_schema: file_system_output_schema,
        mutating: false,
        concurrency_safe: true,
        runtime_modes: ALL_FILE_SYSTEM_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
    ActionDescriptor {
        action: "workspace.read",
        namespace: "workspace",
        description: "Read one workspace-relative file.",
        input_schema: fs_workspace_read_input_schema,
        output_schema: file_system_output_schema,
        mutating: false,
        concurrency_safe: true,
        runtime_modes: ALL_FILE_SYSTEM_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
    ActionDescriptor {
        action: "workspace.search",
        namespace: "workspace",
        description: "Search workspace files by text query.",
        input_schema: fs_workspace_search_input_schema,
        output_schema: file_system_output_schema,
        mutating: false,
        concurrency_safe: true,
        runtime_modes: ALL_FILE_SYSTEM_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
    ActionDescriptor {
        action: "knowledge.list",
        namespace: "knowledge",
        description: "List entries inside advisor knowledge, shared knowledge, or a registered document source.",
        input_schema: fs_knowledge_list_input_schema,
        output_schema: file_system_output_schema,
        mutating: false,
        concurrency_safe: true,
        runtime_modes: ALL_FILE_SYSTEM_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
    ActionDescriptor {
        action: "knowledge.read",
        namespace: "knowledge",
        description: "Read one advisor/shared knowledge file or one indexed block from a registered document source.",
        input_schema: fs_knowledge_read_input_schema,
        output_schema: file_system_output_schema,
        mutating: false,
        concurrency_safe: true,
        runtime_modes: ALL_FILE_SYSTEM_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
    ActionDescriptor {
        action: "knowledge.attach",
        namespace: "knowledge",
        description: "Attach one image/audio/video file from advisor/shared knowledge to the next model turn for direct multimodal analysis when the active model supports that media type.",
        input_schema: fs_knowledge_read_input_schema,
        output_schema: file_system_output_schema,
        mutating: false,
        concurrency_safe: true,
        runtime_modes: ALL_FILE_SYSTEM_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
    ActionDescriptor {
        action: "knowledge.search",
        namespace: "knowledge",
        description: "Search advisor knowledge, shared knowledge, or a registered document source by text query.",
        input_schema: fs_knowledge_search_input_schema,
        output_schema: file_system_output_schema,
        mutating: false,
        concurrency_safe: true,
        runtime_modes: ALL_FILE_SYSTEM_RUNTIME_MODES,
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
    let actions = descriptors
        .iter()
        .map(|descriptor| descriptor.action)
        .collect::<Vec<_>>();
    let action_help = descriptors
        .iter()
        .map(|descriptor| format!("{}: {}", descriptor.action, descriptor.description))
        .collect::<Vec<_>>()
        .join("; ");
    json!({
        "type": "function",
        "function": {
            "name": tool_name,
            "description": description,
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": actions,
                        "description": format!("Structured action name. Available actions: {action_help}"),
                    },
                    "payload": {
                        "type": "object",
                        "description": "Structured arguments for the selected action. Field requirements are validated by the host for the specific action.",
                        "additionalProperties": true,
                    }
                },
                "required": ["action"],
                "additionalProperties": false
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
        "redbox_fs" => REDBOX_FS_ACTIONS,
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
        "redbox_fs" => REDBOX_FS_ACTIONS,
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
        "Read" => Some(ToolDescriptor {
            name: "Read",
            description: READ_DESCRIPTION,
            kind: ToolKind::FileSystem,
            requires_approval: false,
            concurrency_safe: true,
            output_budget_chars: 20_000,
        }),
        "List" => Some(ToolDescriptor {
            name: "List",
            description: LIST_DESCRIPTION,
            kind: ToolKind::FileSystem,
            requires_approval: false,
            concurrency_safe: true,
            output_budget_chars: 16_000,
        }),
        "Search" => Some(ToolDescriptor {
            name: "Search",
            description: SEARCH_DESCRIPTION,
            kind: ToolKind::FileSystem,
            requires_approval: false,
            concurrency_safe: true,
            output_budget_chars: 20_000,
        }),
        "Write" => Some(ToolDescriptor {
            name: "Write",
            description: WRITE_DESCRIPTION,
            kind: ToolKind::Editor,
            requires_approval: false,
            concurrency_safe: false,
            output_budget_chars: 16_000,
        }),
        "Redbox" => Some(ToolDescriptor {
            name: "Redbox",
            description: REDBOX_DESCRIPTION,
            kind: ToolKind::AppCli,
            requires_approval: false,
            concurrency_safe: false,
            output_budget_chars: 20_000,
        }),
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
            description: "Read-only shell inspection inside currentSpaceRoot. Supports pwd, ls, find, rg, cat, head, tail, sed, wc, jq, and read-only git commands. Do not use this for real host CLI execution, PATH checks, curl, which, type, command -v, node, npm, pnpm, or tool-specific CLIs; use app_cli(action=\"cli_runtime.inspect\"|\"cli_runtime.diagnose\"|\"cli_runtime.execute\") instead.",
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
            description: "Unified structured file access for workspace and advisor/member knowledge. Prefer explicit actions such as workspace.list, workspace.read, workspace.search, knowledge.list, knowledge.read, and knowledge.search.",
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
        "Read" => Some(json!({
            "type": "function",
            "function": {
                "name": "Read",
                "description": READ_DESCRIPTION,
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": virtual_path_schema("Resource path to read. Omit a protocol to read from the current workspace."),
                        "offset": { "type": "integer", "minimum": 0, "description": "Optional 0-based line offset for text resources." },
                        "limit": { "type": "integer", "minimum": 1, "maximum": 400, "description": "Optional maximum lines for text resources." },
                        "maxChars": { "type": "integer", "minimum": 200, "maximum": 20000, "description": "Optional maximum response characters." }
                    },
                    "required": ["path"],
                    "additionalProperties": false
                }
            }
        })),
        "List" => Some(json!({
            "type": "function",
            "function": {
                "name": "List",
                "description": LIST_DESCRIPTION,
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": virtual_path_schema("Directory or collection path to list. Omit a protocol to list from the current workspace."),
                        "pattern": { "type": "string", "description": "Optional glob pattern within the selected path or collection." },
                        "limit": { "type": "integer", "minimum": 1, "maximum": 200, "description": "Maximum entries to return." }
                    },
                    "required": ["path"],
                    "additionalProperties": false
                }
            }
        })),
        "Search" => Some(json!({
            "type": "function",
            "function": {
                "name": "Search",
                "description": SEARCH_DESCRIPTION,
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": { "type": "string", "description": "Text or regex query to search for." },
                        "path": virtual_path_schema("Optional path or collection to search. Omit for workspace search."),
                        "glob": { "type": "string", "description": "Optional file glob filter for workspace or knowledge search." },
                        "limit": { "type": "integer", "minimum": 1, "maximum": 100, "description": "Maximum matches to return." },
                        "snippetChars": { "type": "integer", "minimum": 80, "maximum": 800, "description": "Maximum snippet characters per hit." }
                    },
                    "required": ["query"],
                    "additionalProperties": false
                }
            }
        })),
        "Write" => Some(json!({
            "type": "function",
            "function": {
                "name": "Write",
                "description": WRITE_DESCRIPTION,
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": virtual_path_schema("Target resource path. Supported write paths are manuscripts://current and editor://current/script."),
                        "content": { "type": "string", "description": "Complete replacement content to write." },
                        "source": { "type": "string", "enum": ["user", "ai", "system"], "description": "Optional content source for editor script writes." }
                    },
                    "required": ["path", "content"],
                    "additionalProperties": false
                }
            }
        })),
        "Redbox" => Some(redbox_tool_schema(None)),
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
        "redbox_fs" => Some(build_action_tool_schema(
            "redbox_fs",
            "Unified structured file access for workspace and advisor/member knowledge. Prefer explicit actions such as workspace.list, workspace.read, workspace.search, knowledge.list, knowledge.read, and knowledge.search.",
            &action_descriptors_for_tool("redbox_fs", runtime_mode, ActionVisibility::Model),
        )),
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
        "redbox_fs" => Some(build_action_tool_schema(
            "redbox_fs",
            "Unified structured file access for workspace and advisor/member knowledge. Prefer explicit actions such as workspace.list, workspace.read, workspace.search, knowledge.list, knowledge.read, and knowledge.search.",
            descriptors,
        )),
        "redbox_editor" => Some(build_action_tool_schema(
            "redbox_editor",
            REDBOX_EDITOR_DESCRIPTION,
            descriptors,
        )),
        "Redbox" => Some(redbox_tool_schema(Some(descriptors))),
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
        assert_eq!(parameters["type"].as_str(), Some("object"));
        assert_eq!(
            parameters["properties"]["action"]["type"].as_str(),
            Some("string")
        );
        assert!(parameters["properties"]["action"]["enum"].is_array());
    }

    #[test]
    fn app_cli_schema_filters_actions_by_runtime_mode() {
        let schema = schema_for_tool_for_runtime_mode("app_cli", Some("diagnostics"))
            .expect("diagnostics schema should exist");
        let actions = schema["function"]["parameters"]["properties"]["action"]["enum"]
            .as_array()
            .expect("action enum");
        let actions = actions.iter().filter_map(Value::as_str).collect::<Vec<_>>();
        assert!(actions.contains(&"runtime.query"));
        assert!(actions.contains(&"cli_runtime.detect"));
        assert!(actions.contains(&"cli_runtime.discover"));
        assert!(actions.contains(&"cli_runtime.execution.get"));
        assert!(actions.contains(&"mcp.list"));
        assert!(actions.contains(&"mcp.discoverLocal"));
        assert!(actions.contains(&"mcp.importLocal"));
        assert!(actions.contains(&"mcp.save"));
        assert!(actions.contains(&"mcp.test"));
        assert!(actions.contains(&"mcp.listResourceTemplates"));
        assert!(!actions.contains(&"manuscripts.writeCurrent"));
    }

    #[test]
    fn chatroom_schema_exposes_mcp_setup_actions() {
        let schema = schema_for_tool_for_runtime_mode("app_cli", Some("chatroom"))
            .expect("chatroom schema should exist");
        let actions = schema["function"]["parameters"]["properties"]["action"]["enum"]
            .as_array()
            .expect("action enum")
            .iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>();

        for action in [
            "mcp.list",
            "mcp.discoverLocal",
            "mcp.importLocal",
            "mcp.save",
            "mcp.test",
            "mcp.listTools",
            "mcp.listResources",
            "mcp.listResourceTemplates",
            "mcp.sessions",
            "mcp.oauthStatus",
        ] {
            assert!(actions.contains(&action), "{action}");
        }
    }

    #[test]
    fn image_generation_schema_exposes_media_generation_actions() {
        let schema = schema_for_tool_for_runtime_mode("app_cli", Some("image-generation"))
            .expect("image-generation schema should exist");
        let actions = schema["function"]["parameters"]["properties"]["action"]["enum"]
            .as_array()
            .expect("action enum")
            .iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>();

        assert!(actions.contains(&"image.generate"));
        assert!(actions.contains(&"video.generate"));
        assert!(actions.contains(&"tools.search"));
    }

    #[test]
    fn redclaw_schema_hides_internal_runtime_task_actions() {
        let schema = schema_for_tool_for_runtime_mode("app_cli", Some("redclaw"))
            .expect("redclaw schema should exist");
        let actions = schema["function"]["parameters"]["properties"]["action"]["enum"]
            .as_array()
            .expect("action enum")
            .iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>();
        assert!(actions.contains(&"redclaw.task.preview"));
        assert!(actions.contains(&"redclaw.task.list"));
        assert!(actions.contains(&"cli_runtime.inspect"));
        assert!(!actions.contains(&"runtime.tasks.list"));
        assert!(actions.contains(&"cli_runtime.detect"));
    }

    #[test]
    fn redbox_editor_schema_hides_compat_only_actions() {
        let schema = schema_for_tool_for_runtime_mode("redbox_editor", Some("video-editor"))
            .expect("editor schema should exist");
        let actions = schema["function"]["parameters"]["properties"]["action"]["enum"]
            .as_array()
            .expect("action enum")
            .iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>();
        assert!(actions.contains(&"script_read"));
        assert!(actions.contains(&"ffmpeg_edit"));
        assert!(!actions.contains(&"timeline_read"));
        assert!(!actions.contains(&"undo"));
    }

    #[test]
    fn redbox_fs_schema_uses_explicit_action_variants() {
        let schema = schema_for_tool_for_runtime_mode("redbox_fs", Some("chatroom"))
            .expect("redbox_fs schema should exist");
        let actions = schema["function"]["parameters"]["properties"]["action"]["enum"]
            .as_array()
            .expect("action enum")
            .iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>();
        assert!(actions.contains(&"workspace.list"));
        assert!(actions.contains(&"workspace.read"));
        assert!(actions.contains(&"workspace.search"));
        assert!(actions.contains(&"knowledge.list"));
        assert!(actions.contains(&"knowledge.read"));
        assert!(actions.contains(&"knowledge.search"));
    }

    #[test]
    fn action_tool_schema_parameters_are_top_level_objects() {
        for (tool_name, runtime_mode) in [
            ("Read", Some("redclaw")),
            ("Search", Some("redclaw")),
            ("Redbox", Some("redclaw")),
            ("app_cli", Some("redclaw")),
            ("redbox_fs", Some("wander")),
            ("redbox_editor", Some("video-editor")),
        ] {
            let schema = schema_for_tool_for_runtime_mode(tool_name, runtime_mode)
                .unwrap_or_else(|| panic!("schema should exist for {tool_name}"));
            assert_eq!(
                schema["function"]["parameters"]["type"].as_str(),
                Some("object")
            );
        }
    }

    #[test]
    fn universal_tool_schemas_use_familiar_function_names() {
        let read = schema_for_tool_for_runtime_mode("Read", Some("redclaw"))
            .expect("Read schema should exist");
        assert_eq!(
            read.pointer("/function/name").and_then(Value::as_str),
            Some("Read")
        );
        assert!(read
            .pointer("/function/parameters/properties/path/description")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .contains("Resource path"));

        let redbox = schema_for_tool_for_runtime_mode("Redbox", Some("redclaw"))
            .expect("Redbox schema should exist");
        assert_eq!(
            redbox.pointer("/function/parameters/properties/resource/enum/0"),
            Some(&json!("manuscript"))
        );
        assert_eq!(
            redbox.pointer("/function/parameters/properties/input/properties/aspectRatio/enum/1"),
            Some(&json!("3:4"))
        );
    }

    #[test]
    fn tool_action_family_summary_lists_namespaces() {
        let summary =
            tool_action_family_summary("app_cli", Some("redclaw")).expect("summary should exist");
        assert!(summary.contains("memory"));
        assert!(summary.contains("manuscripts"));
        assert!(summary.contains("team.session"));
        assert!(summary.contains("team.member"));
        assert!(summary.contains("team.task"));
        let fs_summary = tool_action_family_summary("redbox_fs", Some("chatroom"))
            .expect("summary should exist");
        assert!(fs_summary.contains("workspace"));
        assert!(fs_summary.contains("knowledge"));
    }

    #[test]
    fn app_cli_schema_exposes_team_coordinator_actions() {
        let schema = schema_for_tool_for_runtime_mode("app_cli", Some("redclaw"))
            .expect("app_cli schema should exist");
        let actions = schema
            .pointer("/function/parameters/properties/action/enum")
            .and_then(Value::as_array)
            .expect("action enum should exist");
        for action in [
            "team.session.create",
            "team.member.spawn",
            "team.member.match",
            "team.member.rename",
            "team.member.shutdown",
            "team.task.create",
            "team.message.send",
            "team.report.request",
            "team.report.submit",
            "team.artifact.attach",
            "team.blocker.raise",
        ] {
            assert!(actions.iter().any(|item| item == action), "{action}");
        }
    }

    #[test]
    fn redclaw_schema_exposes_web_fetch_and_core_cli_runtime_actions() {
        let schema = schema_for_tool_for_runtime_mode("app_cli", Some("redclaw"))
            .expect("app_cli schema should exist");
        let actions = schema
            .pointer("/function/parameters/properties/action/enum")
            .and_then(Value::as_array)
            .expect("action enum should exist");
        for action in [
            "web.fetch",
            "cli_runtime.inspect",
            "cli_runtime.diagnose",
            "cli_runtime.discover",
            "cli_runtime.execute",
            "cli_runtime.execution.get",
            "mcp.list",
            "mcp.discoverLocal",
            "mcp.importLocal",
            "mcp.save",
            "mcp.test",
            "mcp.listTools",
        ] {
            assert!(actions.iter().any(|item| item == action), "{action}");
        }
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
