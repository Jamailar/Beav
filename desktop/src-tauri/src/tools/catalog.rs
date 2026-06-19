use serde::Serialize;
use serde_json::{json, Value};

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolKind {
    AppCli,
    Bash,
    Shell,
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

const APP_CLI_DESCRIPTION: &str = "Structured business actions for the current runtime mode. Always call it with `action` and an optional `payload` object.";
const REDBOX_EDITOR_DESCRIPTION: &str = "Structured editor actions for the currently bound video/audio manuscript package. Use the script-first flow and controlled ffmpeg actions.";
const READ_DESCRIPTION: &str = "Read one local, web URL, or virtual resource. Use paths like https://example.com/page, workspace://docs/a.md, knowledge://, profiles://creator_profile, manuscripts://current, or editor://current/script. Do not use bash/curl for web pages.";
const LIST_DESCRIPTION: &str = "List a directory or virtual collection. Use workspace:// for files, knowledge:// for knowledge, manuscripts:// for manuscript projects, assets:// for asset library entries, or media:// for media.";
const SEARCH_DESCRIPTION: &str = "Search files or virtual collections by query. Use workspace:// for workspace content, knowledge:// for advisor/shared knowledge, and assets:// for asset library lookup. For public web search, use Operate(resource=\"web\", operation=\"search\", input={\"query\":\"...\"}).";
const WRITE_DESCRIPTION: &str = "Write content to a virtual resource. Use manuscripts://current for the bound manuscript body or editor://current/script for the bound editor script.";
const REDBOX_DESCRIPTION: &str = "Run product-level operations that are not simple read/list/search/write, such as creating manuscripts, generating media, managing tasks, invoking skills, editor workflows, or MCP calls.";
const TOOL_SEARCH_DESCRIPTION: &str = "Search deferred Operate actions and MCP tools that are available to this session but not exposed directly in the current turn. Use this when a tool or action is reported as deferred.";
const ALL_APP_RUNTIME_MODES: &[&str] = &[
    "team",
    "default",
    "image-generation",
    "knowledge",
    "redclaw",
    "background-maintenance",
    "diagnostics",
];
const ALL_EDITOR_RUNTIME_MODES: &[&str] = &[];
const ALL_FILE_SYSTEM_RUNTIME_MODES: &[&str] = &[
    "wander",
    "team",
    "image-generation",
    "knowledge",
    "redclaw",
    "diagnostics",
];
const REDCLAW_RUNTIME_MODES: &[&str] = &[
    "team",
    "default",
    "image-generation",
    "knowledge",
    "redclaw",
];
const MANUSCRIPT_AUTHORING_RUNTIME_MODES: &[&str] = &[
    "team",
    "default",
    "image-generation",
    "knowledge",
    "redclaw",
    "manuscript-editor",
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

fn number_schema(description: &str, minimum: f64, maximum: f64) -> Value {
    json!({
        "type": "number",
        "description": description,
        "minimum": minimum,
        "maximum": maximum,
    })
}

fn speech_emotion_schema(description: &str) -> Value {
    json!({
        "type": "string",
        "description": description,
        "enum": ["happy", "sad", "angry", "fearful", "disgusted", "surprised", "calm", "fluent", "whipser", "whisper"],
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
        "enum": ["auto", "1024x1024", "1024x1536", "1536x1024", "1536x2048", "2048x1536", "1152x2048", "2048x1152"],
    })
}

fn image_quality_schema(description: &str) -> Value {
    json!({
        "type": "string",
        "description": description,
        "enum": ["low", "medium", "high"],
    })
}

fn image_resolution_schema(description: &str) -> Value {
    json!({
        "type": "string",
        "description": description,
        "enum": ["auto", "1K", "2K", "4K"],
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

fn session_resources_list_input_schema() -> Value {
    object_schema(
        &[
            (
                "sessionId",
                string_schema("Optional session id. Defaults to the current chat session."),
            ),
            (
                "kind",
                string_schema("Optional resource kind filter, such as image, video, audio, or file."),
            ),
            (
                "query",
                string_schema("Optional text filter over resource id, name, source, path, and metadata."),
            ),
            (
                "limit",
                integer_schema("Maximum resources to return.", 1, 100),
            ),
            (
                "includeChildSessions",
                bool_schema("Whether to include resources produced by child/team sessions."),
            ),
        ],
        &[],
        Some("List attachments and tool-result files visible in the current session. Use returned reference/path values verbatim in later tool inputs; do not invent local paths."),
    )
}

fn session_resources_get_input_schema() -> Value {
    object_schema(
        &[
            (
                "id",
                string_schema("Resource id returned by session.resources.list."),
            ),
            (
                "reference",
                string_schema("Exact resource reference/path returned by session.resources.list."),
            ),
            (
                "includeChildSessions",
                bool_schema("Whether to include resources produced by child/team sessions."),
            ),
        ],
        &[],
        Some("Get one current-session resource by id or exact reference."),
    )
}

fn plugins_install_input_schema() -> Value {
    object_schema(
        &[
            (
                "path",
                string_schema(
                    "Local plugin directory, plugin archive, or Codex marketplace/cache root to install. Use either path or remotePluginId.",
                ),
            ),
            (
                "remotePluginId",
                string_schema("Codex remote plugin id from plugins.codexMarketplace for authenticated remote install."),
            ),
            (
                "remoteMarketplaceName",
                string_schema("Optional Codex remote marketplace name; defaults to openai-curated-remote."),
            ),
            (
                "codexRoot",
                string_schema("Optional Codex home directory for auth.json/config.toml; defaults to CODEX_HOME or ~/.codex."),
            ),
            (
                "pluginName",
                string_schema("Optional Codex marketplace plugin name when a local marketplace has multiple plugins, or the expected remote plugin name."),
            ),
            (
                "pluginId",
                string_schema("Optional Codex marketplace plugin id when the marketplace has multiple local plugins."),
            ),
            (
                "id",
                string_schema("Optional alias for pluginId when the marketplace has multiple local plugins."),
            ),
        ],
        &[],
        Some("Install a Codex-compatible plugin from either a local path/marketplace root or a Codex remote plugin id."),
    )
}

fn plugins_marketplace_input_schema() -> Value {
    object_schema(
        &[(
            "url",
            string_schema("Optional GitHub-hosted marketplace registry URL."),
        )],
        &[],
        Some("List plugins from the configured marketplace registry."),
    )
}

fn plugins_codex_marketplace_input_schema() -> Value {
    object_schema(
        &[
            (
                "path",
                string_schema("Optional local Codex plugin cache, checkout, marketplace root, or plugin directory to scan."),
            ),
            (
                "codexRoot",
                string_schema("Optional alias for path when scanning a Codex checkout or cache root."),
            ),
        ],
        &[],
        Some("List Codex plugins from the local Codex plugin cache."),
    )
}

fn plugins_discover_local_input_schema() -> Value {
    object_schema(
        &[
            (
                "path",
                string_schema("Local plugin directory, parent directory, or Codex marketplace root."),
            ),
            (
                "sourceRoot",
                string_schema("Alias for path."),
            ),
        ],
        &[],
        Some("Inspect a local Codex-compatible plugin source or marketplace root and return installable plugin candidates."),
    )
}

fn plugins_discover_input_schema() -> Value {
    object_schema(
        &[
            (
                "source",
                json!({
                    "type": "string",
                    "enum": ["installed", "marketplace", "codex", "local"],
                    "description": "Discovery source. Use installed for enabled plugins, marketplace for registry, codex for local Codex cache, and local for a filesystem path."
                }),
            ),
            (
                "url",
                string_schema("Optional GitHub-hosted marketplace registry URL."),
            ),
            (
                "path",
                string_schema("Local plugin directory, parent directory, Codex checkout, or Codex marketplace/cache root."),
            ),
            (
                "sourceRoot",
                string_schema("Alias for path when source=local."),
            ),
            (
                "codexRoot",
                string_schema("Optional Codex home/cache root when source=codex."),
            ),
        ],
        &[],
        Some("Discover installed plugins or installable plugin candidates from a marketplace, Codex cache, or local path."),
    )
}

fn plugins_request_install_input_schema() -> Value {
    object_schema(
        &[
            (
                "toolType",
                json!({
                    "type": "string",
                    "enum": ["plugin", "connector"],
                    "description": "Suggested install target type."
                }),
            ),
            (
                "tool_type",
                json!({
                    "type": "string",
                    "enum": ["plugin", "connector"],
                    "description": "Snake-case alias for toolType."
                }),
            ),
            (
                "actionType",
                string_schema("Suggested action, usually install."),
            ),
            (
                "action_type",
                string_schema("Snake-case alias for actionType."),
            ),
            (
                "toolId",
                string_schema("Plugin id/name or connector id/name returned by plugins.list or plugins.connectors."),
            ),
            (
                "tool_id",
                string_schema("Snake-case alias for toolId."),
            ),
            (
                "suggestReason",
                string_schema("Short user-facing reason for suggesting this plugin or connector."),
            ),
            (
                "suggest_reason",
                string_schema("Snake-case alias for suggestReason."),
            ),
        ],
        &[],
        Some("Return Codex-style plugin or connector install suggestion metadata without installing it."),
    )
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
                "mode",
                json!({
                    "type": "string",
                    "enum": ["search", "list", "recall"],
                    "description": "Memory read mode. Use search for query results, list to browse recent entries, and recall for compact runtime context."
                }),
            ),
            (
                "query",
                string_schema("Free-text search query for durable memory. Required for mode=search or mode=recall."),
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
        &[],
        Some("Unified durable memory read action. Use mode=list, mode=search, or mode=recall instead of separate memory.list or memory.recall actions."),
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

fn memory_manage_input_schema() -> Value {
    object_schema(
        &[
            (
                "operation",
                json!({
                    "type": "string",
                    "enum": ["update", "archive", "rebuildIndex", "diagnostics"],
                    "description": "Memory management operation."
                }),
            ),
            ("id", string_schema("Memory id to update or archive.")),
            (
                "content",
                string_schema("Updated memory text when operation=update."),
            ),
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
            (
                "reason",
                string_schema("Optional update or archive reason."),
            ),
        ],
        &["operation"],
        Some("Update/archive one memory entry or run explicit memory maintenance such as diagnostics/rebuildIndex."),
    )
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

fn web_search_input_schema() -> Value {
    object_schema(
        &[
            ("query", string_schema("Public web search query.")),
            (
                "limit",
                integer_schema("Maximum source entries to return.", 1, 10),
            ),
            (
                "searchContextSize",
                json!({
                    "type": "string",
                    "enum": ["low", "medium", "high"],
                    "description": "Responses-compatible provider-hosted web_search context size hint."
                }),
            ),
            (
                "allowedDomains",
                json!({
                    "type": "array",
                    "items": { "type": "string" },
                    "maxItems": 100,
                    "description": "Optional provider-supported allow list for search domains."
                }),
            ),
            (
                "blockedDomains",
                json!({
                    "type": "array",
                    "items": { "type": "string" },
                    "maxItems": 100,
                    "description": "Optional provider-supported block list for search domains."
                }),
            ),
        ],
        &["query"],
        Some("Search the public web. Prefer this for current facts, news, prices, schedules, or source-backed answers."),
    )
}

fn task_brief_get_input_schema() -> Value {
    object_schema(
        &[("sessionId", string_schema("Optional active session id."))],
        &[],
        Some("Read the current structured Task Brief for a long-running task."),
    )
}

fn task_brief_update_input_schema() -> Value {
    object_schema(
        &[
            (
                "stage",
                string_schema(
                    "Current task stage, such as research, title, draft, validation, or save.",
                ),
            ),
            (
                "status",
                json!({
                    "type": "string",
                    "enum": ["in_progress", "completed", "blocked"],
                    "description": "Status of the current stage."
                }),
            ),
            (
                "brief",
                json!({
                    "type": "object",
                    "additionalProperties": true,
                    "description": "Bounded structured task state: todo, done, importantContext, toolFindings, decisions, validationRequirements, and domain fields."
                }),
            ),
            ("sessionId", string_schema("Optional active session id.")),
        ],
        &["stage", "brief"],
        Some("Update the structured Task Brief after a meaningful stage or tool result so later steps use the same bounded context."),
    )
}

fn task_brief_goal_input_schema() -> Value {
    object_schema(
        &[
            (
                "operation",
                json!({
                    "type": "string",
                    "description": "Goal lifecycle operation.",
                    "enum": ["get", "create", "update"]
                }),
            ),
            (
                "objective",
                string_schema("Concrete goal objective when operation=create."),
            ),
            (
                "status",
                json!({
                    "type": "string",
                    "enum": ["active", "complete", "blocked", "cancelled"],
                    "description": "Goal lifecycle status when operation=update."
                }),
            ),
            (
                "tokenBudget",
                integer_schema("Optional positive token budget for this goal.", 1, i64::MAX),
            ),
            (
                "tokenUsage",
                integer_schema(
                    "Optional consumed token count reported by the runtime.",
                    0,
                    i64::MAX,
                ),
            ),
            ("reason", string_schema("Reason for status change.")),
            ("sessionId", string_schema("Optional active session id.")),
            (
                "goal",
                json!({
                    "type": "object",
                    "additionalProperties": true,
                    "description": "Operation-specific bounded goal patch. Top-level fields are also accepted."
                }),
            ),
        ],
        &["operation"],
        Some("Read, create, or update the active Task Brief goal lifecycle state."),
    )
}

fn task_brief_context_input_schema() -> Value {
    object_schema(
        &[
            (
                "operation",
                json!({
                    "type": "string",
                    "description": "Context-window operation.",
                    "enum": ["get", "compact"]
                }),
            ),
            (
                "force",
                json!({
                    "type": "boolean",
                    "description": "When true with operation=compact, force manual compaction when enough history exists."
                }),
            ),
            ("sessionId", string_schema("Optional active session id.")),
        ],
        &["operation"],
        Some("Read estimated session context usage or compact old history into a bounded summary."),
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

fn profile_read_input_schema() -> Value {
    object_schema(
        &[(
            "docType",
            json!({
                "type": "string",
                "enum": ["agent", "soul", "user", "creator_profile"],
                "description": "Optional profile document to read. Omit to read the full profile bundle."
            }),
        )],
        &[],
        Some("Read the RedClaw profile bundle or one profile document."),
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

fn redclaw_profile_complete_style_definition_input_schema() -> Value {
    object_schema(
        &[
            ("summary", json!({ "type": ["object", "string"] })),
            (
                "styleProfile",
                json!({ "type": "object", "additionalProperties": true }),
            ),
            (
                "identityMarkdown",
                string_schema("Optional replacement identity.md Markdown."),
            ),
            (
                "soulMarkdown",
                string_schema("Replacement Soul.md Markdown."),
            ),
            (
                "userMarkdown",
                string_schema("Replacement user.md Markdown."),
            ),
            (
                "creatorProfileMarkdown",
                string_schema("Replacement CreatorProfile.md Markdown."),
            ),
            (
                "writingStyleSkillMarkdown",
                string_schema("Complete replacement writing-style SKILL.md Markdown."),
            ),
            (
                "evidenceNotes",
                json!({ "type": ["array", "object", "string"] }),
            ),
        ],
        &[
            "summary",
            "styleProfile",
            "soulMarkdown",
            "userMarkdown",
            "creatorProfileMarkdown",
            "writingStyleSkillMarkdown",
        ],
        None,
    )
}

fn profile_manage_input_schema() -> Value {
    object_schema(
        &[
            (
                "operation",
                json!({
                    "type": "string",
                    "description": "Profile management operation.",
                    "enum": ["update", "completeStyleDefinition"]
                }),
            ),
            (
                "docType",
                json!({
                    "type": "string",
                    "enum": ["agent", "soul", "user", "creator_profile"],
                    "description": "Profile document type for update operations."
                }),
            ),
            ("markdown", string_schema("Replacement Markdown content.")),
            ("reason", string_schema("Optional update rationale.")),
            (
                "payload",
                json!({
                    "type": "object",
                    "additionalProperties": true,
                    "description": "Operation-specific structured payload. Top-level fields are also accepted."
                }),
            ),
        ],
        &["operation"],
        Some(
            "Run one atomic profile management operation. Prefer this consolidated action over redclaw.profile.* compatibility actions.",
        ),
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

fn runner_manage_input_schema() -> Value {
    object_schema(
        &[
            (
                "operation",
                json!({
                    "type": "string",
                    "description": "Runner lifecycle operation.",
                    "enum": ["status", "start", "stop", "setConfig", "runNow"]
                }),
            ),
            (
                "config",
                json!({
                    "type": "object",
                    "additionalProperties": true,
                    "description": "Runner config patch when operation=setConfig."
                }),
            ),
            (
                "payload",
                json!({
                    "type": "object",
                    "additionalProperties": true,
                    "description": "Operation-specific structured payload. Top-level fields are also accepted."
                }),
            ),
        ],
        &["operation"],
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
                string_schema(
                    "Per-round instruction for long-cycle tasks. Required for long_cycle.",
                ),
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
                bool_schema(
                    "Set true to remove the underlying scheduled or long-cycle task instead of only disabling it.",
                ),
            ),
        ],
        &["jobDefinitionId"],
        None,
    )
}

fn task_manage_input_schema() -> Value {
    object_schema(
        &[
            (
                "operation",
                json!({
                    "type": "string",
                    "description": "Task management operation.",
                    "enum": ["create", "confirm", "update", "cancel"]
                }),
            ),
            (
                "previewToken",
                string_schema("Preview token returned by task.preview."),
            ),
            ("draftId", string_schema("Draft id returned by task.manage create.")),
            (
                "jobDefinitionId",
                string_schema("Target job definition id for update/cancel."),
            ),
            ("confirm", bool_schema("Whether to activate a pending draft.")),
            (
                "patch",
                json!({
                    "type": "object",
                    "additionalProperties": true,
                }),
            ),
            ("reason", string_schema("Reason for update/cancel.")),
            (
                "deleteSource",
                bool_schema("Set true only when the user explicitly asks to delete the task."),
            ),
            (
                "payload",
                json!({
                    "type": "object",
                    "additionalProperties": true,
                    "description": "Operation-specific structured payload. Top-level fields are also accepted."
                }),
            ),
        ],
        &["operation"],
        Some(
            "Run one atomic RedClaw task management operation after preview or explicit user request. Prefer this consolidated action over redclaw.task.* compatibility actions.",
        ),
    )
}

fn task_read_input_schema() -> Value {
    object_schema(
        &[
            (
                "operation",
                json!({
                    "type": "string",
                    "description": "Task read operation.",
                    "enum": ["preview", "list", "stats"]
                }),
            ),
            ("ownerScope", string_schema("Optional owner scope filter.")),
            (
                "includeDrafts",
                bool_schema("Whether to include pending drafts."),
            ),
            ("stats", bool_schema("Alias for operation=stats when true.")),
            (
                "kind",
                string_schema("Preview task kind: scheduled or long_cycle."),
            ),
            (
                "taskType",
                string_schema(
                    "Preview task type alias, such as scheduled, long_cycle, or reminder.",
                ),
            ),
            ("title", string_schema("Preview task title.")),
            ("goal", string_schema("Preview task goal.")),
            ("prompt", string_schema("Preview task prompt.")),
            ("cron", string_schema("Preview cron expression.")),
            ("timezone", string_schema("Preview timezone.")),
            (
                "payload",
                json!({
                    "type": "object",
                    "additionalProperties": true,
                    "description": "Operation-specific structured payload. Top-level fields are also accepted."
                }),
            ),
        ],
        &["operation"],
        Some("Read RedClaw task state with operation=preview|list|stats."),
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

fn task_list_input_schema() -> Value {
    object_schema(
        &[
            (
                "operation",
                json!({
                    "type": "string",
                    "enum": ["list", "stats"],
                    "description": "Use list for task definitions and stats for task counters."
                }),
            ),
            ("ownerScope", string_schema("Optional owner scope filter.")),
            (
                "includeDrafts",
                bool_schema("Whether to include pending drafts."),
            ),
            ("stats", bool_schema("Alias for operation=stats when true.")),
        ],
        &[],
        Some("List RedClaw task definitions or task counters."),
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
                    "enum": ["post", "article"],
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
            (
                "query",
                string_schema("Free-text asset library search query."),
            ),
            ("categoryId", string_schema("Optional category filter.")),
        ],
        &["query"],
        None,
    )
}

fn subjects_get_input_schema() -> Value {
    object_schema(&[("id", string_schema("Asset id."))], &["id"], None)
}

fn asset_attributes_schema() -> Value {
    json!({
        "type": "array",
        "items": {
            "type": "object",
            "properties": {
                "key": { "type": "string" },
                "value": { "type": "string" }
            },
            "required": ["key", "value"],
            "additionalProperties": false
        }
    })
}

fn asset_images_schema() -> Value {
    json!({
        "type": "array",
        "maxItems": 5,
        "items": {
            "type": "object",
            "properties": {
                "relativePath": {
                    "type": "string",
                    "description": "Managed asset-relative image path already present in the asset folder."
                },
                "dataUrl": {
                    "type": "string",
                    "description": "Base64 data URL for a new local reference image."
                },
                "name": {
                    "type": "string",
                    "description": "Optional original file name used for extension and display hints."
                }
            },
            "additionalProperties": false
        }
    })
}

fn asset_voice_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "relativePath": {
                "type": "string",
                "description": "Managed asset-relative audio sample path already present in the asset folder."
            },
            "dataUrl": {
                "type": "string",
                "description": "Base64 data URL for a new local voice sample."
            },
            "name": { "type": "string" },
            "scriptText": { "type": "string" },
            "voice": {
                "type": "object",
                "description": "Optional existing voice binding metadata.",
                "additionalProperties": true
            }
        },
        "additionalProperties": false
    })
}

fn assets_create_input_schema() -> Value {
    object_schema(
        &[
            ("id", string_schema("Optional stable asset id.")),
            ("name", string_schema("Asset display name.")),
            (
                "kind",
                string_schema("Optional typed asset kind, such as character, product, scene, prop, brand, model, or voice."),
            ),
            ("categoryId", string_schema("Optional existing asset category id.")),
            (
                "categoryName",
                string_schema("Optional category name. The host resolves or creates it before writing the asset."),
            ),
            ("description", string_schema("Reusable asset description.")),
            (
                "tags",
                json!({ "type": "array", "items": { "type": "string" } }),
            ),
            ("attributes", asset_attributes_schema()),
            ("images", asset_images_schema()),
            ("voice", asset_voice_schema()),
        ],
        &["name"],
        Some("Create a reusable local asset. Use kind=character and categoryName=角色 for role/character assets."),
    )
}

fn assets_update_input_schema() -> Value {
    object_schema(
        &[
            ("id", string_schema("Asset id.")),
            ("name", string_schema("Asset display name.")),
            ("kind", string_schema("Optional typed asset kind.")),
            ("categoryId", string_schema("Optional existing asset category id.")),
            (
                "categoryName",
                string_schema("Optional category name. The host resolves or creates it before writing the asset."),
            ),
            ("description", string_schema("Reusable asset description.")),
            (
                "tags",
                json!({ "type": "array", "items": { "type": "string" } }),
            ),
            ("attributes", asset_attributes_schema()),
            ("images", asset_images_schema()),
            ("voice", asset_voice_schema()),
        ],
        &["id", "name"],
        Some("Update a reusable local asset."),
    )
}

fn assets_category_create_input_schema() -> Value {
    object_schema(
        &[("name", string_schema("Category name."))],
        &["name"],
        None,
    )
}

fn assets_manage_input_schema() -> Value {
    object_schema(
        &[
            (
                "operation",
                json!({
                    "type": "string",
                    "enum": ["create", "update", "delete", "category.create"],
                    "description": "One asset management operation to perform."
                }),
            ),
            ("id", string_schema("Asset id for update/delete.")),
            ("assetId", string_schema("Compatibility alias for id.")),
            ("subjectId", string_schema("Compatibility alias for id.")),
            ("name", string_schema("Asset or category display name.")),
            (
                "kind",
                string_schema("Optional typed asset kind, such as character, product, scene, prop, brand, model, or voice."),
            ),
            ("categoryId", string_schema("Optional existing asset category id.")),
            (
                "categoryName",
                string_schema("Optional category name. The host resolves or creates it before writing the asset."),
            ),
            ("description", string_schema("Reusable asset description.")),
            (
                "tags",
                json!({ "type": "array", "items": { "type": "string" } }),
            ),
            ("attributes", asset_attributes_schema()),
            ("images", asset_images_schema()),
            ("voice", asset_voice_schema()),
        ],
        &["operation"],
        Some("Perform one low-frequency asset mutation. Use assets.search/get/categories.list for reads and assets.generateCharacterCard for image generation."),
    )
}

fn assets_generate_character_card_input_schema() -> Value {
    object_schema(
        &[
            ("id", string_schema("Character asset id.")),
            ("assetId", string_schema("Alias for id.")),
            ("subjectId", string_schema("Legacy alias for id.")),
        ],
        &[],
        Some("Generate a 16:9 character card image for a character asset and attach it back to the asset."),
    )
}

fn subjects_output_schema() -> Value {
    ok_output_schema(json!({
        "type": "object",
        "properties": {
            "asset": { "type": "object" },
            "assets": { "type": "array", "items": { "type": "object" } },
            "subject": { "type": "object" },
            "subjects": { "type": "array", "items": { "type": "object" } },
            "category": { "type": "object" },
            "categories": { "type": "array", "items": { "type": "object" } }
        },
        "additionalProperties": true
    }))
}

fn voice_clone_input_schema() -> Value {
    object_schema(
        &[
            (
                "samplePath",
                string_schema(
                    "Managed local audio sample path. Relative paths are resolved inside the workspace or the owner asset folder.",
                ),
            ),
            (
                "sampleFileKey",
                string_schema(
                    "Managed OSS sample file key. Use only for samples already uploaded to the platform.",
                ),
            ),
            (
                "ownerAssetId",
                string_schema("Optional asset library subject id that owns this sample."),
            ),
            ("name", string_schema("Optional user-facing voice name.")),
            (
                "language",
                string_schema("Optional sample language, such as zh, en, or nl."),
            ),
            (
                "model",
                string_schema("Optional clone model key; use cosyvoice-v3.5-plus-voice-clone for CosyVoice V3.5 cloning."),
            ),
            (
                "targetTtsModel",
                string_schema("Optional target TTS model for this cloned voice, such as cosyvoice-v3.5-plus. The host stores the resulting voiceId under this model."),
            ),
            (
                "writeBack",
                bool_schema(
                    "Whether to write the resulting voiceId back to ownerAssetId. Defaults to true.",
                ),
            ),
            (
                "waitForCompletion",
                bool_schema(
                    "When true, wait for the queued voice clone job to complete before returning.",
                ),
            ),
        ],
        &[],
        Some(
            "Queue a managed local or OSS audio sample for cloning into a reusable platform voice_id. Do not pass external URLs.",
        ),
    )
}

fn voice_bind_asset_input_schema() -> Value {
    object_schema(
        &[
            (
                "ownerAssetId",
                string_schema("Asset library subject id that should receive this voice binding."),
            ),
            (
                "voiceId",
                string_schema("Platform voice id to bind to the asset."),
            ),
            ("name", string_schema("Optional user-facing voice name.")),
            ("language", string_schema("Optional voice language.")),
            (
                "sampleFileKey",
                string_schema("Optional managed OSS sample key."),
            ),
            (
                "sampleFilePath",
                string_schema("Optional local sample path relative to the asset folder."),
            ),
            (
                "status",
                string_schema("Optional binding status. Defaults to ready."),
            ),
        ],
        &["ownerAssetId", "voiceId"],
        Some("Bind an existing platform voice_id to a person or role asset."),
    )
}

fn voice_speech_input_schema() -> Value {
    let voice_setting_schema = json!({
        "type": "object",
        "description": "MiniMax-compatible voice controls. Top-level speed/pitch/emotion are preferred for new calls; emotion is only forwarded to MiniMax-family TTS models.",
        "properties": {
            "voice_id": { "type": "string" },
            "speed": { "type": "number", "minimum": 0.5, "maximum": 2.0 },
            "pitch": { "type": "integer", "minimum": -12, "maximum": 12, "description": "MiniMax-only segment pitch control. Do not use this for CosyVoice; set CosyVoice pitch inside SSML <speak pitch=\"1\"> where neutral is 1, not 0." },
            "emotion": { "type": "string", "enum": ["happy", "sad", "angry", "fearful", "disgusted", "surprised", "calm", "fluent", "whipser", "whisper"] },
            "add_silence": { "type": "number" }
        },
        "additionalProperties": true
    });
    let audio_setting_schema = json!({
        "type": "object",
        "description": "Optional audio output controls, such as sample_rate, bitrate, and channel.",
        "properties": {
            "sample_rate": { "type": "integer" },
            "bitrate": { "type": "integer" },
            "channel": { "type": "integer" },
            "format": { "type": "string" }
        },
        "additionalProperties": true
    });
    let speech_segment_schema = json!({
        "type": "object",
        "description": "One ordered TTS segment. Segment controls override the parent voice.speech controls, including voiceId and prompt. Use segments for MiniMax-family models with emotion controls, and for CosyVoice only inside a video-director managed digital-human / VideoRetalk TTS substep. In that CosyVoice subflow, each segment should contain one complete SSML input plus a segment-specific prompt.",
        "properties": {
            "input": { "type": "string", "description": "Exact spoken text or SSML for this segment. For CosyVoice inside a digital-human / VideoRetalk subflow, this should be one complete <speak rate=\"...\" pitch=\"...\" volume=\"...\">...</speak> SSML segment. CosyVoice pitch is a positive 0.5-2 multiplier where neutral is pitch=\"1\", not pitch=\"0\". CosyVoice volume is 0-100, not 0-1. For MiniMax, plain text with MiniMax pause markers and tone tags is allowed." },
            "text": { "type": "string", "description": "Alias for input." },
            "voiceId": { "type": "string" },
            "voice_id": { "type": "string" },
            "voice": { "type": "string" },
            "prompt": { "type": "string", "description": "CosyVoice segment-specific voice style prompt. MiniMax ignores prompt." },
            "speed": { "type": "number", "minimum": 0.5, "maximum": 2.0 },
            "pitch": { "type": "integer", "minimum": -12, "maximum": 12 },
            "emotion": { "type": "string", "enum": ["happy", "sad", "angry", "fearful", "disgusted", "surprised", "calm", "fluent", "whipser", "whisper"] },
            "add_silence": { "type": "number" },
            "pauseBeforeSeconds": { "type": "number", "minimum": 0, "maximum": 10, "description": "Structured silent gap inserted by the media runtime before this generated segment during final audio_sequence merge. Use for inter-speaker or inter-scene silence, not spoken text." },
            "pauseAfterSeconds": { "type": "number", "minimum": 0, "maximum": 10, "description": "Structured silent gap inserted by the media runtime after this generated segment during final audio_sequence merge. Use for inter-speaker or inter-scene silence, not spoken text." },
            "voice_setting": voice_setting_schema.clone()
        },
        "required": ["input"],
        "additionalProperties": true
    });
    object_schema(
        &[
            (
                "input",
                string_schema(
                    "Final narration script text to synthesize. If the user is asking for any video or 口播视频, the workflow must start from `video-director`; do not use voice.speech as the video entrypoint. For CosyVoice-family models, activate `cosyvoice-ssml` only inside a `video-director` managed digital-human / VideoRetalk / asset-library talking-head TTS substep after the script, role voiceId, and character video reference are resolved. In that narrow flow, use ordered `segments` with one complete `<speak rate pitch volume>` SSML input and a segment-specific `prompt` per segment. Outside that flow, keep CosyVoice payloads conservative and do not activate `cosyvoice-ssml`. For MiniMax-family models, use plain text or `segments`; MiniMax pause markers like <#0.6#> and tone tags like (laughs) or (sighs) are allowed only for MiniMax."
                ),
            ),
            (
                "segments",
                json!({
                    "type": "array",
                    "description": "Ordered TTS segments for multi-sentence narration, dialogue, short-video口播, ads, product explanation, or any speech that needs emphasis changes. For CosyVoice, use `cosyvoice-ssml` only inside a video-director managed digital-human / VideoRetalk / asset-library talking-head TTS substep; each segment should include one complete SSML input and a segment-specific prompt. For MiniMax, use segments with emotion, speed, pitch, and pause strategy.",
                    "items": speech_segment_schema,
                    "minItems": 1,
                    "maxItems": 50
                }),
            ),
            (
                "voiceId",
                string_schema(
                    "Exact platform voice id to use for synthesis. Required unless `voice` is provided.",
                ),
            ),
            (
                "voice",
                string_schema("OpenAI-compatible alias for voiceId."),
            ),
            (
                "voiceRef",
                string_schema("Alias for voiceId, commonly from asset references."),
            ),
            (
                "model",
                string_schema("Optional TTS model key. Voice ids are model-bound; cosyvoice-v3.5-plus only accepts cloned/designed CosyVoice voices, not MiniMax system voices."),
            ),
            (
                "prompt",
                string_schema("Optional TTS delivery prompt, such as voice style, tone, pace, or emotion guidance. Forwarded to CosyVoice-family TTS models; MiniMax-family models ignore it."),
            ),
            (
                "language_hints",
                json!({
                    "type": "array",
                    "description": "Optional language hints for providers that support language-aware speech synthesis, such as [\"zh\"].",
                    "items": { "type": "string" }
                }),
            ),
            (
                "languageBoost",
                string_schema("Optional language boost value, such as Chinese."),
            ),
            (
                "speed",
                number_schema("Speech speed. Use 1.0 as neutral; supported range is 0.5 to 2.0.", 0.5, 2.0),
            ),
            (
                "pitch",
                integer_schema("Pitch shift from -12 to 12. Use 0 unless the user asks for a higher or lower tone.", -12, 12),
            ),
            (
                "emotion",
                speech_emotion_schema("MiniMax speech emotion. Forwarded only to MiniMax-family TTS models; CosyVoice-family models ignore emotion; CosyVoice SSML plus prompt is reserved for digital-human / VideoRetalk subflows."),
            ),
            (
                "add_silence",
                json!({ "type": "number", "description": "MiniMax native sentence silence passthrough." }),
            ),
            ("voice_setting", voice_setting_schema),
            ("audio_setting", audio_setting_schema),
            (
                "prefer_sync_tts",
                bool_schema("Prefer synchronous TTS when the backend supports both sync and async modes."),
            ),
            (
                "prefer_async_tts",
                bool_schema("Prefer asynchronous TTS for long narration when the backend supports it."),
            ),
            (
                "async_tts",
                bool_schema("Force async TTS mode when supported by the backend."),
            ),
            (
                "responseFormat",
                string_schema("Audio format, usually mp3."),
            ),
            (
                "title",
                string_schema("Optional media library title for the generated audio asset."),
            ),
            (
                "projectId",
                string_schema("Optional project id to attach to the generated media asset."),
            ),
            (
                "boundManuscriptPath",
                string_schema("Optional manuscript path to bind the generated audio asset."),
            ),
            (
                "waitForCompletion",
                bool_schema(
                    "When true, wait for the queued audio job to complete before returning.",
                ),
            ),
        ],
        &["voiceId"],
        Some(
            "Generate narration audio from `input` or ordered `segments` using a platform voice id. Always include the selected TTS `model` when known. This is not the entrypoint for video requests; AI chat video work must start from `video-director`. CosyVoice may activate `cosyvoice-ssml` only inside a video-director managed digital-human / VideoRetalk / asset-library talking-head TTS substep; unsupported CosyVoice SSML such as <prosody> is rejected locally, and CosyVoice pitch neutral is 1, not 0. MiniMax should invoke `tts-director` and then create `segments` with `emotion` controls. Do not call voice.speech repeatedly and merge manually.",
        ),
    )
}

fn voice_get_input_schema() -> Value {
    object_schema(
        &[("voiceId", string_schema("Platform voice id."))],
        &["voiceId"],
        None,
    )
}

fn generation_job_list_input_schema() -> Value {
    object_schema(
        &[
            (
                "kind",
                json!({
                    "type": "string",
                    "enum": ["image", "video", "video_sequence", "audio", "audio_sequence", "voice_clone"],
                    "description": "Optional media generation job kind filter."
                }),
            ),
            (
                "status",
                json!({
                    "type": "string",
                    "enum": ["accepted", "queued", "submitting", "submitted", "polling", "downloading", "persisting", "binding", "completed", "failed", "cancel_requested", "cancelled", "dead_lettered"],
                    "description": "Optional media generation job status filter."
                }),
            ),
            (
                "source",
                string_schema("Optional source filter, such as generation_studio, tool, or brand-workspace-product-detail."),
            ),
            (
                "ownerSessionId",
                string_schema("Optional owner chat/session id filter."),
            ),
            (
                "limit",
                integer_schema("Maximum jobs to return, newest first.", 1, 50),
            ),
            (
                "includeArchived",
                bool_schema("Include archived/deleted jobs."),
            ),
        ],
        &[],
        Some("List recent media generation jobs and their status. Use this to answer image/video generation progress questions."),
    )
}

fn generation_job_get_input_schema() -> Value {
    object_schema(
        &[(
            "jobId",
            string_schema("Media generation job id, for example media-job-1779456047692."),
        )],
        &["jobId"],
        Some("Read one media generation job with status, progress, recent events, attempts, and artifacts."),
    )
}

fn voice_output_schema() -> Value {
    ok_output_schema(json!({
        "type": "object",
        "properties": {
            "voice": { "type": "object" },
            "voices": { "type": "array", "items": { "type": "object" } },
            "voiceId": { "type": "string" },
            "asset": { "type": "object" },
            "jobId": { "type": "string" },
            "status": { "type": "string" },
            "relativePath": { "type": "string" }
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

fn approval_request_input_schema() -> Value {
    object_schema(
        &[
            ("title", string_schema("Short user-visible approval title.")),
            (
                "summary",
                string_schema("One-sentence summary of what the agent needs approved."),
            ),
            (
                "body",
                string_schema("Optional detailed approval context, risks, or evidence."),
            ),
            (
                "decisionType",
                string_schema(
                    "Optional decision type, such as approve_reject, choose_option, or review_changes.",
                ),
            ),
            (
                "priority",
                string_schema("Optional priority: low, normal, high, or urgent."),
            ),
            (
                "riskLevel",
                string_schema("Optional risk level: low, medium, or high."),
            ),
            (
                "proposedAction",
                json!({
                    "type": "object",
                    "description": "Structured action metadata to resume or route after decision.",
                    "additionalProperties": true,
                }),
            ),
            (
                "options",
                json!({
                    "type": "array",
                    "description": "Optional structured decision options.",
                    "items": { "type": "object", "additionalProperties": true },
                }),
            ),
            (
                "waitForDecision",
                bool_schema(
                    "Whether the tool should wait for the user's decision before returning.",
                ),
            ),
            (
                "timeoutMs",
                integer_schema("Wait timeout in milliseconds.", 1000, 21_600_000),
            ),
        ],
        &["title", "summary"],
        Some("Create a generic human approval request and optionally wait for the decision."),
    )
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

fn tool_search_schema() -> Value {
    json!({
        "type": "function",
        "function": {
            "name": "tool_search",
            "description": TOOL_SEARCH_DESCRIPTION,
            "parameters": tools_search_input_schema()
        }
    })
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
            (
                "userConfirmedTeamPlan",
                json!({
                    "type": "boolean",
                    "description": "Must be true only after the user has explicitly confirmed the proposed team members and division of work in this conversation."
                }),
            ),
        ],
        &["objective", "userConfirmedTeamPlan"],
        Some(
            "Create a Workboard collaboration project for internal runtime agents. Before calling this, propose the team members and division of work to the user and wait for explicit confirmation.",
        ),
    )
}

fn team_guide_create_input_schema() -> Value {
    object_schema(
        &[
            ("name", string_schema("Confirmed team name.")),
            (
                "summary",
                string_schema("Confirmed team goal, background, and initial instruction."),
            ),
            (
                "members",
                json!({
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "displayName": { "type": "string" },
                            "name": { "type": "string" },
                            "roleId": { "type": "string" },
                            "responsibility": { "type": "string" },
                            "role": { "type": "string" },
                            "deliverable": { "type": "string" },
                            "capabilities": { "type": "array", "items": { "type": "string" } }
                        },
                        "anyOf": [
                            { "required": ["displayName"] },
                            { "required": ["name"] }
                        ]
                    }
                }),
            ),
            (
                "tasks",
                json!({
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "title": { "type": "string" },
                            "memberRoleId": { "type": "string" },
                            "memberName": { "type": "string" },
                            "assignee": { "type": "string" },
                            "description": { "type": "string" },
                            "objective": { "type": "string" },
                            "expectedOutput": { "type": "string" }
                        },
                        "required": ["title"]
                    }
                }),
            ),
            (
                "metadata",
                json!({ "type": "object", "additionalProperties": true }),
            ),
            (
                "autoOpen",
                bool_schema("Whether the RedClaw team room should open automatically."),
            ),
            (
                "userConfirmedTeamPlan",
                json!({
                    "type": "boolean",
                    "description": "Must be true only after the user explicitly confirmed the proposed team members and division of work in a previous message."
                }),
            ),
        ],
        &["summary", "userConfirmedTeamPlan"],
        Some(
            "Create one confirmed internal Team Workboard with members and starter tasks. This is the recommended team creation entrypoint after explicit user confirmation.",
        ),
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
            (
                "userConfirmedTeamPlan",
                json!({
                    "type": "boolean",
                    "description": "Must be true only after the user has explicitly confirmed this member and its responsibility."
                }),
            ),
        ],
        &["sessionId", "displayName", "userConfirmedTeamPlan"],
        Some(
            "Create one internal runtime team member. Do not create external ACP/CLI members. Before spawning members, the user must have confirmed the member list and responsibilities.",
        ),
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
                string_schema(
                    "Optional task type such as research, image_generation, review, or planning.",
                ),
            ),
            (
                "roleId",
                string_schema(
                    "Optional desired role id when the caller already knows the best role.",
                ),
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
            (
                "limit",
                integer_schema("Maximum candidates to return.", 1, 20),
            ),
        ],
        &["sessionId"],
        Some(
            "Rank existing internal runtime team members by persisted agent card, capabilities, tool policy, and current load.",
        ),
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
            (
                "toMemberId",
                string_schema("Recipient member id, or * to broadcast to all active members except the sender."),
            ),
            ("taskId", string_schema("Related task id.")),
            ("subject", string_schema("Message subject.")),
            ("body", string_schema("Message body.")),
            ("messageType", string_schema("Message type.")),
            (
                "payload",
                json!({ "type": "object", "additionalProperties": true }),
            ),
        ],
        &["sessionId", "toMemberId", "body"],
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

fn team_control_input_schema() -> Value {
    object_schema(
        &[
            (
                "operation",
                json!({
                    "type": "string",
                    "description": "Team control operation.",
                    "enum": [
                        "session.create",
                        "member.spawn",
                        "member.match",
                        "member.rename",
                        "member.shutdown",
                        "member.interrupt",
                        "member.resume",
                        "member.wait",
                        "task.create",
                        "task.update",
                        "message.send",
                        "report.request",
                        "report.submit",
                        "artifact.attach",
                        "blocker.raise"
                    ]
                }),
            ),
            ("sessionId", string_schema("Collaboration session id.")),
            ("memberId", string_schema("Target or reporting member id.")),
            ("taskId", string_schema("Target task id.")),
            ("displayName", string_schema("Visible team member name.")),
            ("roleId", string_schema("Stable internal role id.")),
            ("title", string_schema("Task or session title.")),
            ("objective", string_schema("Concrete objective.")),
            ("description", string_schema("Detailed instructions.")),
            ("status", string_schema("Member, task, or report status.")),
            ("summary", string_schema("Progress, artifact, or blocker summary.")),
            ("body", string_schema("Message or report request body.")),
            (
                "timeoutMs",
                integer_schema("Maximum wait time in milliseconds for member.wait.", 0, 30000),
            ),
            (
                "payload",
                json!({
                    "type": "object",
                    "additionalProperties": true,
                    "description": "Operation-specific structured payload. Top-level fields are also accepted."
                }),
            ),
            (
                "userConfirmedTeamPlan",
                json!({
                    "type": "boolean",
                    "description": "Required only for operations that create sessions or members after the user confirms the team plan."
                }),
            ),
        ],
        &["operation"],
        Some(
            "Run one atomic Team Workboard control operation. Prefer this consolidated entrypoint over individual team.* compatibility actions.",
        ),
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
            (
                "toolId",
                string_schema("CLI tool id or exact executable name to inspect."),
            ),
            (
                "id",
                string_schema(
                    "Compatibility alias for toolId or command. Preserve the exact user-provided executable, for example lark-cli; do not shorten it to lark.",
                ),
            ),
            (
                "command",
                string_schema(
                    "Exact command/executable to inspect. Preserve hyphenated names such as lark-cli.",
                ),
            ),
            (
                "executable",
                string_schema("Compatibility alias for the exact command/executable to inspect."),
            ),
            (
                "name",
                string_schema("Compatibility alias for the exact command/executable to inspect."),
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
                string_schema(
                    "Install spec passed to the package manager, for example a package name or binary URL.",
                ),
            ),
            (
                "toolName",
                string_schema(
                    "Expected exact executable name after installation, for example lark-cli.",
                ),
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

fn cli_runtime_execution_write_stdin_input_schema() -> Value {
    object_schema(
        &[
            ("executionId", string_schema("Running CLI execution id.")),
            ("id", string_schema("Compatibility alias for executionId.")),
            ("text", string_schema("Text bytes to write to stdin.")),
            ("input", string_schema("Compatibility alias for text.")),
            (
                "appendNewline",
                bool_schema("Append one newline after text before flushing stdin."),
            ),
            (
                "closeStdin",
                bool_schema(
                    "Close stdin after writing, allowing programs waiting for EOF to continue.",
                ),
            ),
            ("close", bool_schema("Compatibility alias for closeStdin.")),
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
                "name",
                string_schema("Alias for serverId using the configured MCP server name."),
            ),
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

fn mcp_inspect_input_schema() -> Value {
    object_schema(
        &[
            (
                "operation",
                json!({
                    "type": "string",
                    "enum": ["list", "sessions", "get", "tools", "resources", "resourceTemplates"],
                    "description": "MCP read operation."
                }),
            ),
            ("serverId", string_schema("Target MCP server id.")),
            ("id", string_schema("Alias for serverId.")),
            (
                "name",
                string_schema("Alias for serverId using the configured MCP server name."),
            ),
            (
                "server",
                json!({
                    "type": "object",
                    "additionalProperties": true,
                    "description": "Inline MCP server record when it is not saved yet."
                }),
            ),
        ],
        &["operation"],
        Some("Read MCP config, sessions, tools, resources, or resource templates through one consolidated entrypoint."),
    )
}

fn mcp_add_input_schema() -> Value {
    object_schema(
        &[
            (
                "name",
                string_schema("MCP server name. Use ASCII letters, numbers, '-' or '_'."),
            ),
            (
                "url",
                string_schema("Streamable HTTP or SSE MCP endpoint URL."),
            ),
            ("command", string_schema("Stdio MCP server command.")),
            (
                "args",
                json!({
                    "type": "array",
                    "items": { "type": "string" },
                    "description": "Arguments passed to a stdio MCP command."
                }),
            ),
            (
                "env",
                json!({
                    "type": "object",
                    "additionalProperties": { "type": "string" },
                    "description": "Environment variables passed to a stdio MCP command."
                }),
            ),
            (
                "cwd",
                string_schema("Optional working directory for a stdio MCP command."),
            ),
            (
                "transport",
                string_schema("Optional transport override: stdio, streamable-http, or sse."),
            ),
            (
                "enabled",
                bool_schema("Whether the server is enabled after saving."),
            ),
            (
                "bearerTokenEnvVar",
                string_schema("Optional environment variable containing an HTTP bearer token."),
            ),
        ],
        &["name"],
        Some("Provide either url for an HTTP MCP server or command for a stdio MCP server."),
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
                    "description": "Complete MCP server records to save as the active MCP configuration."
                }),
            ),
        ],
        &[],
        None,
    )
}

fn mcp_manage_input_schema() -> Value {
    object_schema(
        &[
            (
                "operation",
                json!({
                    "type": "string",
                    "description": "MCP management operation.",
                    "enum": [
                        "add",
                        "remove",
                        "enable",
                        "disable",
                        "save",
                        "test",
                        "disconnect",
                        "disconnectAll",
                        "discoverLocal",
                        "importLocal",
                        "oauthStatus"
                    ]
                }),
            ),
            ("serverId", string_schema("Target MCP server id.")),
            ("id", string_schema("Alias for serverId.")),
            ("name", string_schema("MCP server name.")),
            ("url", string_schema("Streamable HTTP or SSE MCP endpoint URL.")),
            ("command", string_schema("Stdio MCP server command.")),
            (
                "args",
                json!({
                    "type": "array",
                    "items": { "type": "string" },
                    "description": "Arguments passed to a stdio MCP command."
                }),
            ),
            (
                "env",
                json!({
                    "type": "object",
                    "additionalProperties": { "type": "string" },
                    "description": "Environment variables passed to a stdio MCP command."
                }),
            ),
            ("cwd", string_schema("Optional working directory for stdio MCP.")),
            ("transport", string_schema("Optional transport override.")),
            ("enabled", bool_schema("Whether the server is enabled after saving.")),
            (
                "server",
                json!({
                    "type": "object",
                    "additionalProperties": true,
                    "description": "Inline MCP server record."
                }),
            ),
            (
                "servers",
                json!({
                    "type": "array",
                    "items": { "type": "object", "additionalProperties": true },
                    "description": "Complete MCP server records to save."
                }),
            ),
        ],
        &["operation"],
        Some(
            "Run one atomic MCP management operation. Prefer this consolidated entrypoint over individual mcp.* compatibility actions.",
        ),
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
            ("sessionId", string_schema("Optional runtime session id.")),
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

fn skills_read_input_schema() -> Value {
    object_schema(
        &[("name", string_schema("Skill name to read."))],
        &["name"],
        Some("Read one skill's full instructions and metadata without activating it."),
    )
}

fn skills_inspect_input_schema() -> Value {
    object_schema(
        &[
            (
                "operation",
                json!({
                    "type": "string",
                    "enum": ["list", "read"],
                    "description": "Skill read operation."
                }),
            ),
            ("name", string_schema("Skill name when operation=read.")),
            ("id", string_schema("Alias for name.")),
        ],
        &["operation"],
        Some("List visible skills or read one skill's full instructions without activating it."),
    )
}

fn skills_install_from_repo_input_schema() -> Value {
    object_schema(
        &[
            (
                "source",
                string_schema(
                    "GitHub repository URL, git URL, owner/repo shorthand, or local repository path.",
                ),
            ),
            (
                "ref",
                string_schema("Optional branch, tag, or commit to install from."),
            ),
            (
                "path",
                string_schema(
                    "Optional repository-relative skill directory or bundle subdirectory.",
                ),
            ),
            (
                "paths",
                json!({
                    "type": "array",
                    "items": {
                        "type": "string",
                    },
                    "description": "Optional list of repository-relative skill directories or bundle subdirectories.",
                }),
            ),
            (
                "scope",
                json!({
                    "type": "string",
                    "enum": ["user", "workspace"],
                    "description": "Install into the user skill root by default, or into the current workspace skills directory.",
                }),
            ),
        ],
        &["source"],
        Some("Install one or more Codex-style skills from a repository."),
    )
}

fn skills_uninstall_input_schema() -> Value {
    object_schema(
        &[
            ("name", string_schema("Skill name to uninstall.")),
            (
                "scope",
                json!({
                    "type": "string",
                    "enum": ["user", "workspace"],
                    "description": "Optional install scope to delete from. Defaults to the catalog record scope.",
                }),
            ),
        ],
        &["name"],
        Some("Uninstall a user or workspace skill by deleting its managed skill directory."),
    )
}

fn skills_manage_input_schema() -> Value {
    object_schema(
        &[
            (
                "operation",
                json!({
                    "type": "string",
                    "description": "Skill management operation.",
                    "enum": ["installFromRepo", "uninstall"]
                }),
            ),
            (
                "source",
                string_schema(
                    "Repository URL, git URL, owner/repo shorthand, or local repository path when operation=installFromRepo.",
                ),
            ),
            (
                "ref",
                string_schema("Optional branch, tag, or commit to install from."),
            ),
            (
                "path",
                string_schema("Optional repository-relative skill directory or bundle subdirectory."),
            ),
            (
                "paths",
                json!({
                    "type": "array",
                    "items": { "type": "string" },
                    "description": "Optional list of repository-relative skill directories or bundle subdirectories.",
                }),
            ),
            ("name", string_schema("Skill name when operation=uninstall.")),
            (
                "scope",
                json!({
                    "type": "string",
                    "enum": ["user", "workspace"],
                    "description": "Install/uninstall scope.",
                }),
            ),
            (
                "payload",
                json!({
                    "type": "object",
                    "additionalProperties": true,
                    "description": "Operation-specific structured payload. Top-level fields are also accepted."
                }),
            ),
        ],
        &["operation"],
        Some("Run one explicit skill management operation."),
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
                    "Required image output ratio. Supported values: 1:1 square, 3:4 portrait/Xiaohongshu card, 4:3 landscape, 9:16 vertical story, 16:9 wide. Pick one explicitly; do not leave it empty.",
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
                image_quality_schema(
                    "Required image quality hint. Choose exactly one of low, medium, or high.",
                ),
            ),
            (
                "resolution",
                image_resolution_schema(
                    "Required image resolution tier for image providers. Use 2K by default for product/main images unless the user asks for 1K or 4K.",
                ),
            ),
            ("title", string_schema("Optional media asset title.")),
            ("projectId", string_schema("Optional media project id.")),
            (
                "model",
                string_schema(
                    "Optional model override. Omit this to use the user's Settings default for this media type.",
                ),
            ),
            (
                "planConfirmed",
                bool_schema("Whether the user has confirmed the multi-image plan."),
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
                "images",
                json!({
                    "type": "array",
                    "items": { "type": "string" },
                    "maxItems": 5,
                    "description": "Alias for referenceImages, accepted for image-to-image providers that call the field images."
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
                    "Whether to block until the generation job completes. Single-image chat generation defaults to inline waiting; multi-image chat generation uses a background follow-up unless this is explicitly true.",
                ),
            ),
        ],
        &["prompt", "aspectRatio", "quality", "resolution"],
        None,
    )
}

fn video_generate_input_schema() -> Value {
    object_schema(
        &[
            (
                "prompt",
                string_schema(
                    "Video generation prompt. For long videos, describe the full final video; the runtime can split it into <=15 second upstream segments and concatenate the final result.",
                ),
            ),
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
                "durationSeconds",
                integer_schema(
                    "Requested final video duration in seconds. A single upstream video segment is limited to 15 seconds. If this value is greater than 15, the media runtime automatically creates a video_sequence job, splits the request into <=15 second segments, generates each segment, concatenates them, and returns one final video.",
                    5,
                    3600,
                ),
            ),
            (
                "videoSegments",
                json!({
                    "type": "array",
                    "description": "Optional explicit long-video segments. Use this when you need scene-by-scene control for a final video longer than 15 seconds. Each segment should be <=15 seconds and can include prompt, durationSeconds, referenceImages, generationMode, drivingAudio, or firstClip. The runtime generates each segment and returns one concatenated final video.",
                    "items": { "type": "object", "additionalProperties": true },
                    "minItems": 2,
                }),
            ),
            (
                "aspectRatio",
                string_schema("Video aspect ratio, usually 16:9 or 9:16."),
            ),
            (
                "resolution",
                string_schema("Video resolution, usually 720p or 1080p."),
            ),
            (
                "drivingAudio",
                string_schema("Optional driving audio path."),
            ),
            (
                "waitForCompletion",
                bool_schema(
                    "Whether to block until the generation job completes. In chat sessions this defaults to true; set true when the user is waiting for the finished video, and only set false for explicit background execution.",
                ),
            ),
        ],
        &["prompt"],
        None,
    )
}

fn media_video_retalk_input_schema() -> Value {
    object_schema(
        &[
            (
                "input",
                json!({
                    "type": "object",
                    "description": "Remote source URLs for the VideoRetalk lip-sync job. Local files must be uploaded before calling this action.",
                    "properties": {
                        "video_url": { "type": "string", "description": "HTTPS URL of the source talking-head video." },
                        "audio_url": { "type": "string", "description": "HTTPS URL of the driving audio file." }
                    },
                    "required": ["video_url", "audio_url"],
                    "additionalProperties": false
                }),
            ),
            (
                "parameters",
                json!({
                    "type": "object",
                    "description": "VideoRetalk provider parameters.",
                    "properties": {
                        "video_extension": { "type": "boolean", "description": "Whether the provider should extend the video when audio is longer." }
                    },
                    "additionalProperties": true
                }),
            ),
            (
                "durationSeconds",
                integer_schema("Source video duration in seconds. Required for billing.", 1, 3600),
            ),
            (
                "resolution",
                string_schema("Billing resolution tier, for example 720p or 1080p."),
            ),
            ("title", string_schema("Optional media asset title.")),
            (
                "waitForCompletion",
                bool_schema(
                    "Whether to block until the VideoRetalk job completes. In chat sessions this defaults to true; set false only for explicit background execution.",
                ),
            ),
        ],
        &["input", "durationSeconds", "resolution"],
        Some(
            "Submit a VideoRetalk lip-sync job using a remote character video URL and driving audio URL. The media runtime stores task_id, polls the fixed query endpoint, downloads the completed video, and registers it in the media library.",
        ),
    )
}

fn video_analyze_input_schema() -> Value {
    object_schema(
        &[
            (
                "path",
                string_schema("Workspace-relative or absolute video path."),
            ),
            (
                "toolPath",
                string_schema("Preferred workspace-relative tool path from the attachment."),
            ),
            ("attachmentId", string_schema("Optional attachment id.")),
            ("mimeType", string_schema("Optional video MIME type.")),
            (
                "mode",
                json!({
                    "type": "string",
                    "enum": ["summary", "shot_breakdown", "speech_extract", "highlight_clips", "talking_head_cut", "smart_edit"],
                    "description": "Video analysis mode. Do not use speech_extract for subtitle, caption, transcript, SRT, VTT, ASR, or spoken-text extraction; use media.transcribe instead."
                }),
            ),
            (
                "instruction",
                string_schema("Specific instruction for the Video Analysis Agent."),
            ),
        ],
        &[],
        None,
    )
}

fn media_edit_input_schema() -> Value {
    object_schema(
        &[
            (
                "sourcePath",
                string_schema("Workspace-relative or absolute source video path."),
            ),
            (
                "toolPath",
                string_schema(
                    "Preferred workspace-relative path from an uploaded video attachment.",
                ),
            ),
            (
                "intentSummary",
                string_schema("Concise summary of the requested edit."),
            ),
            (
                "operations",
                json!({
                    "type": "array",
                    "description": "Controlled ffmpeg recipe. Supported types: trim, concat, crop_scale, speed, mute, replace_audio.",
                    "items": {
                        "type": "object",
                        "additionalProperties": true,
                        "properties": {
                            "type": {
                                "type": "string",
                                "enum": ["trim", "concat", "crop_scale", "speed", "mute", "replace_audio"]
                            },
                            "startMs": { "type": "integer" },
                            "durationMs": { "type": "integer" },
                            "label": { "type": "string" },
                            "inputPath": { "type": "string" },
                            "inputPaths": {
                                "type": "array",
                                "items": { "type": "string" }
                            },
                            "speed": { "type": "number" },
                            "audioPath": { "type": "string" }
                        }
                    },
                    "minItems": 1,
                }),
            ),
            (
                "output",
                json!({
                    "type": "object",
                    "additionalProperties": true,
                    "properties": {
                        "kind": {
                            "type": "string",
                            "enum": ["auto", "single-video", "clips"],
                            "description": "Use clips for multiple independent short videos; use single-video when concat is desired."
                        },
                        "directory": { "type": "string" }
                    }
                }),
            ),
        ],
        &["operations"],
        None,
    )
}

fn media_transcribe_input_schema() -> Value {
    object_schema(
        &[
            (
                "sourcePath",
                string_schema("Workspace-relative or absolute source video/audio path."),
            ),
            (
                "toolPath",
                string_schema(
                    "Preferred workspace-relative path from an uploaded video attachment.",
                ),
            ),
            (
                "format",
                json!({
                    "type": "string",
                    "enum": ["srt", "vtt", "text", "txt", "json", "verbose_json"],
                    "description": "Transcript output format. Use srt when subtitles or editing are needed."
                }),
            ),
            ("language", string_schema("Optional language hint.")),
            (
                "output",
                json!({
                    "type": "object",
                    "additionalProperties": true,
                    "properties": {
                        "directory": { "type": "string" }
                    }
                }),
            ),
        ],
        &[],
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

fn fs_workspace_inspect_image_input_schema() -> Value {
    object_schema(
        &[
            (
                "path",
                string_schema("Workspace-relative local image file path to inspect."),
            ),
            (
                "includeDataUrl",
                bool_schema("Whether to include a base64 data URL for small images."),
            ),
            (
                "maxBytes",
                integer_schema(
                    "Maximum file bytes allowed when includeDataUrl is true.",
                    1,
                    2_000_000,
                ),
            ),
        ],
        &["path"],
        Some("Inspect one local workspace image without invoking the model vision path."),
    )
}

fn fs_workspace_create_directory_input_schema() -> Value {
    object_schema(
        &[(
            "path",
            string_schema(
                "Workspace-relative directory path to create. Parent directories are created as needed.",
            ),
        )],
        &["path"],
        None,
    )
}

fn fs_workspace_write_input_schema() -> Value {
    object_schema(
        &[
            (
                "path",
                string_schema(
                    "Workspace-relative file path to write. Parent directories are created as needed.",
                ),
            ),
            (
                "content",
                string_schema("Complete UTF-8 text content to write."),
            ),
        ],
        &["path", "content"],
        None,
    )
}

fn fs_workspace_patch_input_schema() -> Value {
    object_schema(
        &[
            (
                "operation",
                json!({
                    "type": "string",
                    "enum": ["edit", "create", "delete", "move"],
                    "description": "Patch operation. Defaults to edit when omitted."
                }),
            ),
            (
                "path",
                string_schema("Workspace-relative UTF-8 file path to patch, create, delete, or move."),
            ),
            (
                "toPath",
                string_schema("Workspace-relative destination file path for operation=move."),
            ),
            (
                "content",
                string_schema("Complete UTF-8 text content for operation=create."),
            ),
            (
                "edits",
                json!({
                    "type": "array",
                    "minItems": 1,
                    "items": {
                        "type": "object",
                        "properties": {
                            "oldText": {
                                "type": "string",
                                "description": "Exact text to replace. Must match once unless replaceAll is true."
                            },
                            "newText": {
                                "type": "string",
                                "description": "Replacement text."
                            },
                            "replaceAll": {
                                "type": "boolean",
                                "description": "When true, replace every occurrence of oldText."
                            }
                        },
                        "required": ["oldText", "newText"],
                        "additionalProperties": false
                    }
                }),
            ),
        ],
        &["path"],
        Some(
            "Apply one structured workspace patch operation. Supports exact replacements for existing UTF-8 files plus create/delete/move.",
        ),
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
                string_schema(
                    "Optional collaboration member id; when provided, knowledge resolves to that member's bound advisor or document source.",
                ),
            ),
            ("collabMemberId", string_schema("Alias for memberId.")),
            (
                "sourceId",
                string_schema(
                    "Optional registered document source id to search instead of advisor/shared knowledge.",
                ),
            ),
            (
                "rootPath",
                string_schema(
                    "Optional registered document source root path when sourceId is not available.",
                ),
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
                string_schema(
                    "Optional collaboration member id; when provided, knowledge resolves to that member's bound advisor or document source.",
                ),
            ),
            ("collabMemberId", string_schema("Alias for memberId.")),
            (
                "sourceId",
                string_schema(
                    "Optional registered document source id to search instead of advisor/shared knowledge.",
                ),
            ),
            (
                "rootPath",
                string_schema(
                    "Optional registered document source root path when sourceId is not available.",
                ),
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
                string_schema(
                    "Optional collaboration member id; when provided, knowledge resolves to that member's bound advisor or document source.",
                ),
            ),
            ("collabMemberId", string_schema("Alias for memberId.")),
            (
                "sourceId",
                string_schema(
                    "Optional registered document source id to read instead of advisor/shared knowledge.",
                ),
            ),
            (
                "rootPath",
                string_schema(
                    "Optional registered document source root path when sourceId is not available.",
                ),
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
                integer_schema(
                    "Maximum media bytes for knowledge.attach.",
                    1,
                    20 * 1024 * 1024,
                ),
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

fn editor_export_input_schema() -> Value {
    object_schema(
        &[
            ("filePath", editor_file_locator_schema()),
            (
                "renderMode",
                json!({
                    "type": "string",
                    "enum": ["full"],
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
            "editor://current/script"
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
        "description": "Product resource family. Prefer Read/List/Search/Write for simple resource access; use Operate for product operations with side effects or workflow semantics."
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
        "description": "Generic operation for the selected resource. The host maps this stable verb to the existing action contract."
    })
}

fn redbox_resource_enum_for_actions(descriptors: &[ActionDescriptor]) -> Vec<&'static str> {
    let mut resources = if descriptors.is_empty() {
        [
            "manuscript",
            "profile",
            "memory",
            "asset",
            "subject",
            "image",
            "video",
            "voice",
            "generation",
            "media",
            "session",
            "web",
            "task",
            "editor",
            "skill",
            "mcp",
            "plugins",
            "runtime",
            "cli_runtime",
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
            "list",
            "get",
            "search",
            "create",
            "update",
            "delete",
            "run",
            "generate",
            "speech",
            "transcribe",
            "export",
            "confirm",
            "cancel",
            "resume",
            "install",
            "request",
            "verify",
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
        "assets" => Some("asset"),
        "subjects" => Some("subject"),
        "image" => Some("image"),
        "video" => Some("video"),
        "voice" => Some("voice"),
        "generation" => Some("generation"),
        "media" => Some("media"),
        "session" => Some("session"),
        "web" => Some("web"),
        "skills" => Some("skill"),
        "mcp" => Some("mcp"),
        "plugins" => Some("plugins"),
        "profile" => Some("profile"),
        "task" => Some("task"),
        "runtime" | "team" => Some("runtime"),
        "cli_runtime" => Some("cli_runtime"),
        "redclaw" if action.starts_with("redclaw.profile.") => Some("profile"),
        "redclaw" if action.starts_with("redclaw.task.") => Some("task"),
        "redclaw" if action.starts_with("redclaw.runner.") => Some("runtime"),
        _ => None,
    }
}

fn redbox_operation_for_action(action: &str) -> Option<&'static str> {
    let verb = action.rsplit('.').next().unwrap_or(action);
    match verb {
        "list" | "marketplace" => Some("list"),
        "search" => Some("search"),
        "get" | "read" | "fetch" | "readCurrent" | "bundle" | "stats" | "status" | "query"
        | "getCheckpoints" | "getToolResults" | "getEvents" | "sessions" | "oauthStatus" => {
            Some("get")
        }
        "create" | "createProject" | "preview" | "add" | "spawn" | "send" | "request" | "start" => {
            Some("create")
        }
        "requestInstall" => Some("request"),
        "update" | "writeCurrent" | "submit" | "setConfig" => Some("update"),
        "delete" | "disconnect" | "disconnectAll" | "deny" | "stop" => Some("delete"),
        "cancel" => Some("cancel"),
        "resume" => Some("resume"),
        "confirm" | "approve" => Some("confirm"),
        "invoke" | "call" | "execute" => Some("run"),
        "generate" => Some("generate"),
        "speech" => Some("speech"),
        "transcribe" => Some("transcribe"),
        "install" | "save" | "importLocal" => Some("install"),
        "verify" | "diagnose" | "inspect" | "detect" | "discover" | "discoverLocal" | "test" => {
            Some("verify")
        }
        "tools" | "listTools" | "listResources" | "listResourceTemplates" => Some("list"),
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
            "name": "Operate",
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
        "description": "Structured operation input. For image generation, put prompt/count/aspectRatio/resolution/quality/referenceImages here; aspectRatio, resolution, and quality are required and must be non-empty.",
        "properties": {
            "prompt": { "type": "string", "description": "Generation or operation prompt." },
            "input": { "type": "string", "description": "Literal text input for speech/TTS. If the user asks for any video or 口播视频, start from video-director instead of voice.speech. For CosyVoice, activate cosyvoice-ssml only inside a video-director managed digital-human / VideoRetalk / asset-library talking-head TTS substep after the script, role voiceId, and character video reference are resolved. In that narrow flow, segments may use complete <speak rate pitch volume> SSML input and segment-specific prompt. Outside that flow, keep CosyVoice payloads conservative and do not activate cosyvoice-ssml. For MiniMax expressive narration, invoke tts-director and prefer segments. MiniMax pause markers like <#0.6#> and tone tags like (laughs) are allowed only for MiniMax." },
            "segments": {
                "type": "array",
                "description": "Ordered TTS segments for multi-sentence narration, short-video口播, ads, product explanation, dialogue, or any speech needing emphasis changes. For CosyVoice, use cosyvoice-ssml only inside a video-director managed digital-human / VideoRetalk / asset-library talking-head TTS substep; each segment uses one complete SSML input plus segment-specific prompt. For MiniMax, use emotion, speed, pitch, and pauses.",
                "maxItems": 50,
                "items": {
                    "type": "object",
                    "required": ["input"],
                    "additionalProperties": true,
                    "properties": {
                        "input": { "type": "string" },
                        "text": { "type": "string" },
                        "prompt": { "type": "string", "description": "CosyVoice segment-specific voice style prompt." },
                        "speed": { "type": "number", "minimum": 0.5, "maximum": 2.0 },
                        "pitch": { "type": "integer", "minimum": -12, "maximum": 12, "description": "MiniMax-only segment pitch control. Do not use this for CosyVoice; set CosyVoice pitch inside SSML <speak pitch=\"1\"> where neutral is 1, not 0." },
                        "emotion": { "type": "string", "enum": ["happy", "sad", "angry", "fearful", "disgusted", "surprised", "calm", "fluent", "whipser", "whisper"] },
                        "add_silence": { "type": "number" },
                        "pauseBeforeSeconds": { "type": "number", "minimum": 0, "maximum": 10, "description": "Silent gap inserted before this segment during final merge." },
                        "pauseAfterSeconds": { "type": "number", "minimum": 0, "maximum": 10, "description": "Silent gap inserted after this segment during final merge." },
                        "voice_setting": { "type": "object", "additionalProperties": true }
                    }
                }
            },
            "voiceId": { "type": "string", "description": "Platform voice id for speech/TTS, usually read from an asset's voice.voiceId." },
            "title": { "type": "string", "description": "Optional generated media title." },
            "responseFormat": { "type": "string", "description": "Optional audio format for speech/TTS, usually mp3 or wav." },
            "languageBoost": { "type": "string", "description": "Optional language boost for speech/TTS, such as zh-CN." },
            "speed": { "type": "number", "minimum": 0.5, "maximum": 2.0, "description": "Optional TTS speed. 1.0 is neutral; use subtle values such as 0.92 or 1.08 unless asked otherwise." },
            "pitch": { "type": "integer", "minimum": -12, "maximum": 12, "description": "Optional MiniMax TTS pitch. 0 is neutral only for MiniMax. Do not use this for CosyVoice; set CosyVoice pitch inside SSML <speak pitch=\"1\"> where neutral is 1." },
            "emotion": { "type": "string", "enum": ["happy", "sad", "angry", "fearful", "disgusted", "surprised", "calm", "fluent", "whipser", "whisper"], "description": "Optional MiniMax TTS emotion. CosyVoice models ignore emotion; CosyVoice SSML plus prompt is reserved for digital-human / VideoRetalk subflows." },
            "add_silence": { "type": "number", "description": "Optional MiniMax sentence silence passthrough." },
            "voice_setting": { "type": "object", "description": "Optional native MiniMax voice_setting passthrough.", "additionalProperties": true },
            "audio_setting": { "type": "object", "description": "Optional audio controls such as sample_rate, bitrate, and channel.", "additionalProperties": true },
            "prefer_sync_tts": { "type": "boolean", "description": "Prefer synchronous TTS when supported." },
            "prefer_async_tts": { "type": "boolean", "description": "Prefer asynchronous TTS for long narration when supported." },
            "async_tts": { "type": "boolean", "description": "Force async TTS when supported." },
            "waitForCompletion": { "type": "boolean", "description": "For generated media needed by the next step, set true so the tool returns the completed asset path." },
            "count": { "type": "integer", "minimum": 1, "maximum": 6, "description": "Number of images or generated items." },
            "aspectRatio": image_aspect_ratio_schema("Required image output ratio for image generation. Pick one explicitly, such as 1:1, 3:4, 4:3, 9:16, or 16:9."),
            "ratio": image_aspect_ratio_schema("Alias for aspectRatio; prefer aspectRatio in new calls."),
            "size": image_size_schema("Optional explicit output size. Prefer aspectRatio unless exact pixels were requested."),
            "quality": image_quality_schema("Required non-empty image quality hint. Choose exactly one of low, medium, or high."),
            "resolution": image_resolution_schema("Required non-empty image resolution tier for image providers, usually 2K unless the user asks otherwise."),
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
            "images": {
                "type": "array",
                "items": { "type": "string" },
                "maxItems": 5,
                "description": "Alias for referenceImages; useful for image-to-image APIs whose native payload uses images."
            },
            "planConfirmed": { "type": "boolean", "description": "Whether the user approved a multi-image plan." },
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
        action: "web.search",
        namespace: "web",
        description: "Search the public web and return provider-hosted or configured search results with source metadata. Use this for current facts, recent events, prices, schedules, or when the user asks to look something up.",
        input_schema: web_search_input_schema,
        output_schema: generic_state_output_schema,
        mutating: false,
        concurrency_safe: true,
        runtime_modes: ALL_APP_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
    ActionDescriptor {
        action: "taskBrief.get",
        namespace: "taskBrief",
        description: "Read the current structured Task Brief for this long-running task, including todo, important context, findings, decisions, and validation requirements.",
        input_schema: task_brief_get_input_schema,
        output_schema: generic_state_output_schema,
        mutating: false,
        concurrency_safe: true,
        runtime_modes: ALL_APP_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
    ActionDescriptor {
        action: "taskBrief.update",
        namespace: "taskBrief",
        description: "Update the current structured Task Brief after a meaningful stage or tool result. Use it to preserve todo, key context, research findings, decisions, and validation requirements for later steps.",
        input_schema: task_brief_update_input_schema,
        output_schema: generic_state_output_schema,
        mutating: true,
        concurrency_safe: false,
        runtime_modes: ALL_APP_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
    ActionDescriptor {
        action: "taskBrief.goal",
        namespace: "taskBrief",
        description: "Read, create, or update the current Task Brief goal lifecycle state, including objective, status, token budget, token usage, and completion/blocker reason.",
        input_schema: task_brief_goal_input_schema,
        output_schema: generic_state_output_schema,
        mutating: true,
        concurrency_safe: false,
        runtime_modes: ALL_APP_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
    ActionDescriptor {
        action: "taskBrief.context",
        namespace: "taskBrief",
        description: "Read estimated current-session context usage or compact old history into a bounded summary. This is the RedConvert equivalent of Codex context budget utilities.",
        input_schema: task_brief_context_input_schema,
        output_schema: generic_state_output_schema,
        mutating: true,
        concurrency_safe: false,
        runtime_modes: ALL_APP_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
    ActionDescriptor {
        action: "session.resources.list",
        namespace: "session.resources",
        description: "List files and media resources visible in the current session, including user attachments and prior tool-generated assets. Use this when a later tool call needs an exact reference path from the current conversation.",
        input_schema: session_resources_list_input_schema,
        output_schema: generic_state_output_schema,
        mutating: false,
        concurrency_safe: true,
        runtime_modes: ALL_APP_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
    ActionDescriptor {
        action: "session.resources.get",
        namespace: "session.resources",
        description: "Get one current-session file or media resource by id or exact reference path.",
        input_schema: session_resources_get_input_schema,
        output_schema: generic_state_output_schema,
        mutating: false,
        concurrency_safe: true,
        runtime_modes: ALL_APP_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
    ActionDescriptor {
        action: "plugins.list",
        namespace: "plugins",
        description: "List installed Codex-compatible plugins and their contributed skills, MCP servers, hooks, and app connector declarations.",
        input_schema: no_payload_schema,
        output_schema: generic_state_output_schema,
        mutating: false,
        concurrency_safe: true,
        runtime_modes: ALL_APP_RUNTIME_MODES,
        visibility: ActionVisibility::CompatOnly,
    },
    ActionDescriptor {
        action: "plugins.connectors",
        namespace: "plugins",
        description: "List Codex AppInfo-style connector declarations contributed by enabled plugins.",
        input_schema: no_payload_schema,
        output_schema: generic_state_output_schema,
        mutating: false,
        concurrency_safe: true,
        runtime_modes: ALL_APP_RUNTIME_MODES,
        visibility: ActionVisibility::CompatOnly,
    },
    ActionDescriptor {
        action: "plugins.discover",
        namespace: "plugins",
        description: "Discover installed plugins or installable Codex-compatible plugin candidates from the marketplace, local Codex cache, or a filesystem path.",
        input_schema: plugins_discover_input_schema,
        output_schema: generic_state_output_schema,
        mutating: false,
        concurrency_safe: false,
        runtime_modes: ALL_APP_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
    ActionDescriptor {
        action: "plugins.marketplace",
        namespace: "plugins",
        description: "List marketplace plugins from a GitHub-hosted plugin registry.",
        input_schema: plugins_marketplace_input_schema,
        output_schema: generic_state_output_schema,
        mutating: false,
        concurrency_safe: false,
        runtime_modes: ALL_APP_RUNTIME_MODES,
        visibility: ActionVisibility::CompatOnly,
    },
    ActionDescriptor {
        action: "plugins.codexMarketplace",
        namespace: "plugins",
        description: "List Codex plugins from the local Codex plugin cache so they can be installed into RedBox.",
        input_schema: plugins_codex_marketplace_input_schema,
        output_schema: generic_state_output_schema,
        mutating: false,
        concurrency_safe: true,
        runtime_modes: ALL_APP_RUNTIME_MODES,
        visibility: ActionVisibility::CompatOnly,
    },
    ActionDescriptor {
        action: "plugins.discoverLocal",
        namespace: "plugins",
        description: "Inspect a local Codex plugin directory, parent directory, or marketplace root and return installable local plugin candidates.",
        input_schema: plugins_discover_local_input_schema,
        output_schema: generic_state_output_schema,
        mutating: false,
        concurrency_safe: true,
        runtime_modes: ALL_APP_RUNTIME_MODES,
        visibility: ActionVisibility::CompatOnly,
    },
    ActionDescriptor {
        action: "plugins.install",
        namespace: "plugins",
        description: "Install a Codex-compatible plugin from a local plugin path, archive, or Codex marketplace root.",
        input_schema: plugins_install_input_schema,
        output_schema: generic_state_output_schema,
        mutating: true,
        concurrency_safe: false,
        runtime_modes: ALL_APP_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
    ActionDescriptor {
        action: "plugins.installCodex",
        namespace: "plugins",
        description: "Install a Codex plugin from a local Codex marketplace/cache item or a Codex remote marketplace plugin id.",
        input_schema: plugins_install_input_schema,
        output_schema: generic_state_output_schema,
        mutating: true,
        concurrency_safe: false,
        runtime_modes: ALL_APP_RUNTIME_MODES,
        visibility: ActionVisibility::CompatOnly,
    },
    ActionDescriptor {
        action: "plugins.requestInstall",
        namespace: "plugins",
        description: "Return Codex-style install suggestion metadata for a discovered plugin or connector. Use this before recommending a plugin or connector install.",
        input_schema: plugins_request_install_input_schema,
        output_schema: generic_state_output_schema,
        mutating: false,
        concurrency_safe: false,
        runtime_modes: ALL_APP_RUNTIME_MODES,
        visibility: ActionVisibility::CompatOnly,
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
        visibility: ActionVisibility::CompatOnly,
    },
    ActionDescriptor {
        action: "memory.search",
        namespace: "memory",
        description: "Read durable memory entries with mode=list, mode=search, or mode=recall. Use this consolidated action instead of memory.list or memory.recall compatibility actions.",
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
        visibility: ActionVisibility::CompatOnly,
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
        visibility: ActionVisibility::CompatOnly,
    },
    ActionDescriptor {
        action: "memory.note",
        namespace: "memory",
        description: "Append one durable memory note after the user explicitly asks to remember or record a fact.",
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
        visibility: ActionVisibility::CompatOnly,
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
        visibility: ActionVisibility::CompatOnly,
    },
    ActionDescriptor {
        action: "memory.manage",
        namespace: "memory",
        description: "Update, archive, rebuild, or inspect durable memory state after an explicit user request.",
        input_schema: memory_manage_input_schema,
        output_schema: memory_output_schema,
        mutating: true,
        concurrency_safe: false,
        runtime_modes: ALL_APP_RUNTIME_MODES,
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
        runtime_modes: DIAGNOSTIC_RUNTIME_MODES,
        visibility: ActionVisibility::CompatOnly,
    },
    ActionDescriptor {
        action: "memory.diagnostics",
        namespace: "memory",
        description: "Inspect durable memory index status and retrieval engine diagnostics.",
        input_schema: memory_diagnostics_input_schema,
        output_schema: memory_output_schema,
        mutating: false,
        concurrency_safe: true,
        runtime_modes: DIAGNOSTIC_RUNTIME_MODES,
        visibility: ActionVisibility::CompatOnly,
    },
    ActionDescriptor {
        action: "redclaw.profile.bundle",
        namespace: "redclaw.profile",
        description: "Read the AI profile bundle and onboarding state.",
        input_schema: redclaw_profile_bundle_input_schema,
        output_schema: redclaw_profile_output_schema,
        mutating: false,
        concurrency_safe: true,
        runtime_modes: REDCLAW_RUNTIME_MODES,
        visibility: ActionVisibility::CompatOnly,
    },
    ActionDescriptor {
        action: "redclaw.profile.read",
        namespace: "redclaw.profile",
        description: "Read one durable AI profile document.",
        input_schema: redclaw_profile_read_input_schema,
        output_schema: redclaw_profile_output_schema,
        mutating: false,
        concurrency_safe: true,
        runtime_modes: REDCLAW_RUNTIME_MODES,
        visibility: ActionVisibility::CompatOnly,
    },
    ActionDescriptor {
        action: "profile.read",
        namespace: "profile",
        description: "Read the RedClaw profile bundle or one durable profile document.",
        input_schema: profile_read_input_schema,
        output_schema: redclaw_profile_output_schema,
        mutating: false,
        concurrency_safe: true,
        runtime_modes: REDCLAW_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
    ActionDescriptor {
        action: "profile.manage",
        namespace: "profile",
        description: "Run one atomic RedClaw profile management operation such as updating a profile document or completing the style-definition flow. Use this consolidated action instead of redclaw.profile.* compatibility actions.",
        input_schema: profile_manage_input_schema,
        output_schema: redclaw_profile_output_schema,
        mutating: true,
        concurrency_safe: false,
        runtime_modes: REDCLAW_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
    ActionDescriptor {
        action: "redclaw.profile.update",
        namespace: "redclaw.profile",
        description: "Update one durable AI profile document.",
        input_schema: redclaw_profile_update_input_schema,
        output_schema: redclaw_profile_output_schema,
        mutating: true,
        concurrency_safe: false,
        runtime_modes: REDCLAW_RUNTIME_MODES,
        visibility: ActionVisibility::CompatOnly,
    },
    ActionDescriptor {
        action: "redclaw.profile.completeStyleDefinition",
        namespace: "redclaw.profile",
        description: "Complete the RedClaw style-definition interview after user confirmation and atomically write profile docs, style-profile.json, onboarding state, and the workspace writing-style skill.",
        input_schema: redclaw_profile_complete_style_definition_input_schema,
        output_schema: redclaw_profile_output_schema,
        mutating: true,
        concurrency_safe: false,
        runtime_modes: REDCLAW_RUNTIME_MODES,
        visibility: ActionVisibility::CompatOnly,
    },
    ActionDescriptor {
        action: "redclaw.runner.status",
        namespace: "redclaw.runner",
        description: "Inspect the automation runner and heartbeat state.",
        input_schema: redclaw_runner_status_input_schema,
        output_schema: generic_state_output_schema,
        mutating: false,
        concurrency_safe: true,
        runtime_modes: DIAGNOSTIC_RUNTIME_MODES,
        visibility: ActionVisibility::CompatOnly,
    },
    ActionDescriptor {
        action: "redclaw.runner.start",
        namespace: "redclaw.runner",
        description: "Start the automation runner.",
        input_schema: redclaw_runner_mutation_input_schema,
        output_schema: generic_state_output_schema,
        mutating: true,
        concurrency_safe: false,
        runtime_modes: DIAGNOSTIC_RUNTIME_MODES,
        visibility: ActionVisibility::CompatOnly,
    },
    ActionDescriptor {
        action: "redclaw.runner.stop",
        namespace: "redclaw.runner",
        description: "Stop the automation runner.",
        input_schema: no_payload_schema,
        output_schema: generic_state_output_schema,
        mutating: true,
        concurrency_safe: false,
        runtime_modes: DIAGNOSTIC_RUNTIME_MODES,
        visibility: ActionVisibility::CompatOnly,
    },
    ActionDescriptor {
        action: "redclaw.runner.setConfig",
        namespace: "redclaw.runner",
        description: "Update automation runner configuration.",
        input_schema: redclaw_runner_mutation_input_schema,
        output_schema: generic_state_output_schema,
        mutating: true,
        concurrency_safe: false,
        runtime_modes: DIAGNOSTIC_RUNTIME_MODES,
        visibility: ActionVisibility::CompatOnly,
    },
    ActionDescriptor {
        action: "runner.manage",
        namespace: "redclaw.runner",
        description: "Run one atomic RedClaw automation runner lifecycle operation such as start, stop, run now, or update config. Use this consolidated action instead of redclaw.runner.* compatibility actions.",
        input_schema: runner_manage_input_schema,
        output_schema: generic_state_output_schema,
        mutating: true,
        concurrency_safe: false,
        runtime_modes: DIAGNOSTIC_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
    ActionDescriptor {
        action: "redclaw.task.preview",
        namespace: "redclaw.task",
        description: "Preview a user-facing task definition before creation. Use this for scheduled or long-cycle user tasks, not internal runtime.tasks.*. Scheduled tasks should include cron plus prompt or goal.",
        input_schema: redclaw_task_preview_input_schema,
        output_schema: generic_state_output_schema,
        mutating: false,
        concurrency_safe: true,
        runtime_modes: REDCLAW_RUNTIME_MODES,
        visibility: ActionVisibility::CompatOnly,
    },
    ActionDescriptor {
        action: "task.read",
        namespace: "task",
        description: "Read RedClaw task state with operation=preview, list, or stats. Use this consolidated action instead of task.preview or task.list compatibility actions.",
        input_schema: task_read_input_schema,
        output_schema: generic_state_output_schema,
        mutating: false,
        concurrency_safe: true,
        runtime_modes: REDCLAW_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
    ActionDescriptor {
        action: "task.preview",
        namespace: "task",
        description: "Preview a user-facing RedClaw task definition before creation.",
        input_schema: redclaw_task_preview_input_schema,
        output_schema: generic_state_output_schema,
        mutating: false,
        concurrency_safe: true,
        runtime_modes: REDCLAW_RUNTIME_MODES,
        visibility: ActionVisibility::CompatOnly,
    },
    ActionDescriptor {
        action: "task.manage",
        namespace: "task",
        description: "Run one atomic RedClaw task management operation after preview or explicit user request. Use this consolidated action instead of redclaw.task.* compatibility actions.",
        input_schema: task_manage_input_schema,
        output_schema: generic_state_output_schema,
        mutating: true,
        concurrency_safe: false,
        runtime_modes: REDCLAW_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
    ActionDescriptor {
        action: "redclaw.task.create",
        namespace: "redclaw.task",
        description: "Create a pending task draft from a validated preview token returned by redclaw.task.preview.",
        input_schema: redclaw_task_create_input_schema,
        output_schema: generic_state_output_schema,
        mutating: true,
        concurrency_safe: false,
        runtime_modes: REDCLAW_RUNTIME_MODES,
        visibility: ActionVisibility::CompatOnly,
    },
    ActionDescriptor {
        action: "redclaw.task.confirm",
        namespace: "redclaw.task",
        description: "Confirm or discard a pending task draft. Use after redclaw.task.create.",
        input_schema: redclaw_task_confirm_input_schema,
        output_schema: generic_state_output_schema,
        mutating: true,
        concurrency_safe: false,
        runtime_modes: REDCLAW_RUNTIME_MODES,
        visibility: ActionVisibility::CompatOnly,
    },
    ActionDescriptor {
        action: "redclaw.task.update",
        namespace: "redclaw.task",
        description: "Update an existing task definition with an explicit reason.",
        input_schema: redclaw_task_update_input_schema,
        output_schema: generic_state_output_schema,
        mutating: true,
        concurrency_safe: false,
        runtime_modes: REDCLAW_RUNTIME_MODES,
        visibility: ActionVisibility::CompatOnly,
    },
    ActionDescriptor {
        action: "redclaw.task.cancel",
        namespace: "redclaw.task",
        description: "Disable, discard, or delete a task definition. Set deleteSource=true when the user explicitly asks to delete the task.",
        input_schema: redclaw_task_cancel_input_schema,
        output_schema: generic_state_output_schema,
        mutating: true,
        concurrency_safe: false,
        runtime_modes: REDCLAW_RUNTIME_MODES,
        visibility: ActionVisibility::CompatOnly,
    },
    ActionDescriptor {
        action: "redclaw.task.list",
        namespace: "redclaw.task",
        description: "List task definitions with policy and latest execution state.",
        input_schema: redclaw_task_list_input_schema,
        output_schema: generic_state_output_schema,
        mutating: false,
        concurrency_safe: true,
        runtime_modes: REDCLAW_RUNTIME_MODES,
        visibility: ActionVisibility::CompatOnly,
    },
    ActionDescriptor {
        action: "redclaw.task.stats",
        namespace: "redclaw.task",
        description: "Read task definition and execution counters.",
        input_schema: no_payload_schema,
        output_schema: generic_state_output_schema,
        mutating: false,
        concurrency_safe: true,
        runtime_modes: REDCLAW_RUNTIME_MODES,
        visibility: ActionVisibility::CompatOnly,
    },
    ActionDescriptor {
        action: "task.list",
        namespace: "task",
        description: "List RedClaw task definitions or task counters.",
        input_schema: task_list_input_schema,
        output_schema: generic_state_output_schema,
        mutating: false,
        concurrency_safe: true,
        runtime_modes: REDCLAW_RUNTIME_MODES,
        visibility: ActionVisibility::CompatOnly,
    },
    ActionDescriptor {
        action: "manuscripts.list",
        namespace: "manuscripts",
        description: "List manuscript tree items.",
        input_schema: manuscripts_list_input_schema,
        output_schema: manuscripts_output_schema,
        mutating: false,
        concurrency_safe: true,
        runtime_modes: MANUSCRIPT_AUTHORING_RUNTIME_MODES,
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
        runtime_modes: MANUSCRIPT_AUTHORING_RUNTIME_MODES,
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
        runtime_modes: MANUSCRIPT_AUTHORING_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
    ActionDescriptor {
        action: "assets.search",
        namespace: "assets",
        description: "Search the asset library for person, product, scene, prop, brand, model, voice, or visual reference assets. Returns matching assets with reference image paths.",
        input_schema: subjects_search_input_schema,
        output_schema: subjects_output_schema,
        mutating: false,
        concurrency_safe: true,
        runtime_modes: ALL_APP_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
    ActionDescriptor {
        action: "assets.get",
        namespace: "assets",
        description: "Read one asset library entry by id, including reference image paths and preview URLs when available.",
        input_schema: subjects_get_input_schema,
        output_schema: subjects_output_schema,
        mutating: false,
        concurrency_safe: true,
        runtime_modes: ALL_APP_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
    ActionDescriptor {
        action: "assets.create",
        namespace: "assets",
        description: "Create a reusable local asset such as a character, product, scene, prop, brand, model, voice, or visual reference. For roles, use kind=character and categoryName=角色.",
        input_schema: assets_create_input_schema,
        output_schema: subjects_output_schema,
        mutating: true,
        concurrency_safe: false,
        runtime_modes: ALL_APP_RUNTIME_MODES,
        visibility: ActionVisibility::CompatOnly,
    },
    ActionDescriptor {
        action: "assets.update",
        namespace: "assets",
        description: "Update a reusable local asset by id.",
        input_schema: assets_update_input_schema,
        output_schema: subjects_output_schema,
        mutating: true,
        concurrency_safe: false,
        runtime_modes: ALL_APP_RUNTIME_MODES,
        visibility: ActionVisibility::CompatOnly,
    },
    ActionDescriptor {
        action: "assets.delete",
        namespace: "assets",
        description: "Delete a reusable local asset by id. Use only when the user explicitly asks to remove the asset.",
        input_schema: subjects_get_input_schema,
        output_schema: subjects_output_schema,
        mutating: true,
        concurrency_safe: false,
        runtime_modes: ALL_APP_RUNTIME_MODES,
        visibility: ActionVisibility::CompatOnly,
    },
    ActionDescriptor {
        action: "assets.categories.list",
        namespace: "assets",
        description: "List asset library categories.",
        input_schema: no_payload_schema,
        output_schema: subjects_output_schema,
        mutating: false,
        concurrency_safe: true,
        runtime_modes: ALL_APP_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
    ActionDescriptor {
        action: "assets.categories.create",
        namespace: "assets",
        description: "Create an asset library category.",
        input_schema: assets_category_create_input_schema,
        output_schema: subjects_output_schema,
        mutating: true,
        concurrency_safe: false,
        runtime_modes: ALL_APP_RUNTIME_MODES,
        visibility: ActionVisibility::CompatOnly,
    },
    ActionDescriptor {
        action: "assets.manage",
        namespace: "assets",
        description: "Perform one low-frequency asset mutation: create/update/delete an asset or create an asset category.",
        input_schema: assets_manage_input_schema,
        output_schema: subjects_output_schema,
        mutating: true,
        concurrency_safe: false,
        runtime_modes: ALL_APP_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
    ActionDescriptor {
        action: "assets.generateCharacterCard",
        namespace: "assets",
        description: "Generate a reusable 16:9 character card image for a character asset, then write the result back to the asset image set and media library.",
        input_schema: assets_generate_character_card_input_schema,
        output_schema: subjects_output_schema,
        mutating: true,
        concurrency_safe: false,
        runtime_modes: ALL_APP_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
    ActionDescriptor {
        action: "voice.clone",
        namespace: "voice",
        description: "Queue a managed local or OSS audio sample for cloning into a reusable platform voice_id. Use ownerAssetId when cloning from a person or role asset so the result is written back.",
        input_schema: voice_clone_input_schema,
        output_schema: voice_output_schema,
        mutating: true,
        concurrency_safe: false,
        runtime_modes: ALL_APP_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
    ActionDescriptor {
        action: "voice.bindAsset",
        namespace: "voice",
        description: "Bind an existing platform voice_id to a person or role asset without cloning a new sample.",
        input_schema: voice_bind_asset_input_schema,
        output_schema: voice_output_schema,
        mutating: true,
        concurrency_safe: false,
        runtime_modes: ALL_APP_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
    ActionDescriptor {
        action: "voice.speech",
        namespace: "voice",
        description: "Queue speech synthesis from text or ordered segments with platform voice ids; completion saves the audio result into the media library. For multi-speaker dialogue, use one segments request and put each role's voiceId on its speaker turns.",
        input_schema: voice_speech_input_schema,
        output_schema: voice_output_schema,
        mutating: true,
        concurrency_safe: false,
        runtime_modes: ALL_APP_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
    ActionDescriptor {
        action: "voice.list",
        namespace: "voice",
        description: "List platform voices available through the configured voice gateway. Use before multi-speaker TTS when the current context does not already provide enough role voice ids.",
        input_schema: no_payload_schema,
        output_schema: voice_output_schema,
        mutating: false,
        concurrency_safe: true,
        runtime_modes: ALL_APP_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
    ActionDescriptor {
        action: "voice.get",
        namespace: "voice",
        description: "Read one platform voice by voiceId.",
        input_schema: voice_get_input_schema,
        output_schema: voice_output_schema,
        mutating: false,
        concurrency_safe: true,
        runtime_modes: ALL_APP_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
    ActionDescriptor {
        action: "voice.delete",
        namespace: "voice",
        description: "Delete one platform voice by voiceId. Use only when the user explicitly asks to remove a cloned voice.",
        input_schema: voice_get_input_schema,
        output_schema: voice_output_schema,
        mutating: true,
        concurrency_safe: false,
        runtime_modes: ALL_APP_RUNTIME_MODES,
        visibility: ActionVisibility::CompatOnly,
    },
    ActionDescriptor {
        action: "subjects.search",
        namespace: "subjects",
        description: "Legacy alias for assets.search.",
        input_schema: subjects_search_input_schema,
        output_schema: subjects_output_schema,
        mutating: false,
        concurrency_safe: true,
        runtime_modes: ALL_APP_RUNTIME_MODES,
        visibility: ActionVisibility::CompatOnly,
    },
    ActionDescriptor {
        action: "subjects.get",
        namespace: "subjects",
        description: "Legacy alias for assets.get.",
        input_schema: subjects_get_input_schema,
        output_schema: subjects_output_schema,
        mutating: false,
        concurrency_safe: true,
        runtime_modes: ALL_APP_RUNTIME_MODES,
        visibility: ActionVisibility::CompatOnly,
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
        action: "runtime.getEvents",
        namespace: "runtime",
        description: "Read structured runtime events for a session.",
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
        action: "team.guide.create",
        namespace: "team.guide",
        description: "Create one confirmed internal Team Workboard with members and starter tasks, then open the RedClaw team room automatically. Use this after the user explicitly confirms the team plan.",
        input_schema: team_guide_create_input_schema,
        output_schema: runtime_output_schema,
        mutating: true,
        concurrency_safe: false,
        runtime_modes: ALL_APP_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
    ActionDescriptor {
        action: "team.session.create",
        namespace: "team.session",
        description: "Create a Workboard collaboration project for internal runtime agents when the user asks for team collaboration, multi-role execution, or ongoing progress reporting. Never call this before the user explicitly confirms the proposed team members and division of work.",
        input_schema: team_session_create_input_schema,
        output_schema: runtime_output_schema,
        mutating: true,
        concurrency_safe: false,
        runtime_modes: ALL_APP_RUNTIME_MODES,
        visibility: ActionVisibility::CompatOnly,
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
        description: "Create one internal runtime team member role inside a Workboard collaboration project. Never use this for external ACP/CLI agents. Only call after the user has confirmed this member and responsibility.",
        input_schema: team_member_spawn_input_schema,
        output_schema: runtime_output_schema,
        mutating: true,
        concurrency_safe: false,
        runtime_modes: ALL_APP_RUNTIME_MODES,
        visibility: ActionVisibility::CompatOnly,
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
        visibility: ActionVisibility::CompatOnly,
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
        visibility: ActionVisibility::CompatOnly,
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
        visibility: ActionVisibility::CompatOnly,
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
        visibility: ActionVisibility::CompatOnly,
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
        visibility: ActionVisibility::CompatOnly,
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
        description: "Send a durable mailbox message between internal team members, from the coordinator, or to all active members with toMemberId='*'.",
        input_schema: team_message_send_input_schema,
        output_schema: runtime_output_schema,
        mutating: true,
        concurrency_safe: false,
        runtime_modes: ALL_APP_RUNTIME_MODES,
        visibility: ActionVisibility::CompatOnly,
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
        visibility: ActionVisibility::CompatOnly,
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
        visibility: ActionVisibility::CompatOnly,
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
        visibility: ActionVisibility::CompatOnly,
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
        visibility: ActionVisibility::CompatOnly,
    },
    ActionDescriptor {
        action: "team.control",
        namespace: "team",
        description: "Run one atomic Team Workboard control operation such as create task, send message, request report, attach artifact, or raise blocker. Use this consolidated action instead of individual team.* compatibility actions.",
        input_schema: team_control_input_schema,
        output_schema: runtime_output_schema,
        mutating: true,
        concurrency_safe: false,
        runtime_modes: ALL_APP_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
    ActionDescriptor {
        action: "approval.request",
        namespace: "approval",
        description: "Ask the user to approve, reject, or choose a structured option, then return the decision to the current agent loop.",
        input_schema: approval_request_input_schema,
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
        visibility: ActionVisibility::CompatOnly,
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
        visibility: ActionVisibility::CompatOnly,
    },
    ActionDescriptor {
        action: "cli_runtime.inspect",
        namespace: "cli_runtime",
        description: "Inspect one host CLI executable and refresh its detection record. Preserve the exact executable the user named, for example lark-cli, and use this instead of bash which/type/command -v.",
        input_schema: cli_runtime_inspect_input_schema,
        output_schema: generic_state_output_schema,
        mutating: false,
        concurrency_safe: true,
        runtime_modes: ALL_APP_RUNTIME_MODES,
        visibility: ActionVisibility::CompatOnly,
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
        visibility: ActionVisibility::CompatOnly,
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
        visibility: ActionVisibility::CompatOnly,
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
        visibility: ActionVisibility::CompatOnly,
    },
    ActionDescriptor {
        action: "cli_runtime.install",
        namespace: "cli_runtime",
        description: "Install one CLI tool into a managed environment when the user asked to make a missing CLI usable. Use toolName for the exact expected executable, for example lark-cli.",
        input_schema: cli_runtime_install_input_schema,
        output_schema: generic_state_output_schema,
        mutating: true,
        concurrency_safe: false,
        runtime_modes: ALL_APP_RUNTIME_MODES,
        visibility: ActionVisibility::CompatOnly,
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
        visibility: ActionVisibility::CompatOnly,
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
        visibility: ActionVisibility::CompatOnly,
    },
    ActionDescriptor {
        action: "cli_runtime.execution.writeStdin",
        namespace: "cli_runtime.execution",
        description: "Write explicit text to stdin of one running background CLI execution. Use only after launching a command with usePty=true and an executionId.",
        input_schema: cli_runtime_execution_write_stdin_input_schema,
        output_schema: generic_state_output_schema,
        mutating: true,
        concurrency_safe: false,
        runtime_modes: ALL_APP_RUNTIME_MODES,
        visibility: ActionVisibility::CompatOnly,
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
        visibility: ActionVisibility::CompatOnly,
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
        visibility: ActionVisibility::CompatOnly,
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
        visibility: ActionVisibility::CompatOnly,
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
        visibility: ActionVisibility::CompatOnly,
    },
    ActionDescriptor {
        action: "mcp.manage",
        namespace: "mcp",
        description: "Run one atomic MCP management operation such as add, remove, enable, disable, save, test, disconnect, import local config, or read OAuth status. Use this consolidated action instead of individual mcp.* compatibility actions.",
        input_schema: mcp_manage_input_schema,
        output_schema: generic_state_output_schema,
        mutating: true,
        concurrency_safe: false,
        runtime_modes: ALL_APP_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
    ActionDescriptor {
        action: "mcp.add",
        namespace: "mcp",
        description: "Add or update one MCP server by name, using either a stdio command or a streamable HTTP/SSE URL.",
        input_schema: mcp_add_input_schema,
        output_schema: generic_state_output_schema,
        mutating: true,
        concurrency_safe: false,
        runtime_modes: ALL_APP_RUNTIME_MODES,
        visibility: ActionVisibility::CompatOnly,
    },
    ActionDescriptor {
        action: "mcp.get",
        namespace: "mcp",
        description: "Get one saved MCP server record by id or name.",
        input_schema: mcp_server_target_input_schema,
        output_schema: generic_state_output_schema,
        mutating: false,
        concurrency_safe: true,
        runtime_modes: ALL_APP_RUNTIME_MODES,
        visibility: ActionVisibility::CompatOnly,
    },
    ActionDescriptor {
        action: "mcp.remove",
        namespace: "mcp",
        description: "Remove one saved MCP server by id or name and disconnect its active session.",
        input_schema: mcp_server_target_input_schema,
        output_schema: generic_state_output_schema,
        mutating: true,
        concurrency_safe: false,
        runtime_modes: ALL_APP_RUNTIME_MODES,
        visibility: ActionVisibility::CompatOnly,
    },
    ActionDescriptor {
        action: "mcp.enable",
        namespace: "mcp",
        description: "Enable one saved MCP server by id or name.",
        input_schema: mcp_server_target_input_schema,
        output_schema: generic_state_output_schema,
        mutating: true,
        concurrency_safe: false,
        runtime_modes: ALL_APP_RUNTIME_MODES,
        visibility: ActionVisibility::CompatOnly,
    },
    ActionDescriptor {
        action: "mcp.disable",
        namespace: "mcp",
        description: "Disable one saved MCP server by id or name and disconnect its active session.",
        input_schema: mcp_server_target_input_schema,
        output_schema: generic_state_output_schema,
        mutating: true,
        concurrency_safe: false,
        runtime_modes: ALL_APP_RUNTIME_MODES,
        visibility: ActionVisibility::CompatOnly,
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
        visibility: ActionVisibility::CompatOnly,
    },
    ActionDescriptor {
        action: "mcp.inspect",
        namespace: "mcp",
        description: "Read MCP config, sessions, tools, resources, or resource templates with operation=list, sessions, get, tools, resources, or resourceTemplates.",
        input_schema: mcp_inspect_input_schema,
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
        visibility: ActionVisibility::CompatOnly,
    },
    ActionDescriptor {
        action: "mcp.importLocal",
        namespace: "mcp",
        description: "Import locally discovered MCP server configs and sync the MCP manager.",
        input_schema: mcp_list_input_schema,
        output_schema: generic_state_output_schema,
        mutating: true,
        concurrency_safe: false,
        runtime_modes: ALL_APP_RUNTIME_MODES,
        visibility: ActionVisibility::CompatOnly,
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
        visibility: ActionVisibility::CompatOnly,
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
        visibility: ActionVisibility::CompatOnly,
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
        visibility: ActionVisibility::CompatOnly,
    },
    ActionDescriptor {
        action: "mcp.tools",
        namespace: "mcp",
        description: "List tools exposed by one MCP server.",
        input_schema: mcp_server_target_input_schema,
        output_schema: generic_state_output_schema,
        mutating: false,
        concurrency_safe: true,
        runtime_modes: ALL_APP_RUNTIME_MODES,
        visibility: ActionVisibility::CompatOnly,
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
        visibility: ActionVisibility::CompatOnly,
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
        visibility: ActionVisibility::CompatOnly,
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
        visibility: ActionVisibility::CompatOnly,
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
        visibility: ActionVisibility::CompatOnly,
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
        visibility: ActionVisibility::CompatOnly,
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
        visibility: ActionVisibility::CompatOnly,
    },
    ActionDescriptor {
        action: "skills.read",
        namespace: "skills",
        description: "Read one skill's full instructions and metadata without activating it.",
        input_schema: skills_read_input_schema,
        output_schema: generic_state_output_schema,
        mutating: false,
        concurrency_safe: true,
        runtime_modes: ALL_APP_RUNTIME_MODES,
        visibility: ActionVisibility::CompatOnly,
    },
    ActionDescriptor {
        action: "skills.inspect",
        namespace: "skills",
        description: "List visible skills or read one skill's full instructions without activating it.",
        input_schema: skills_inspect_input_schema,
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
        action: "skills.installFromRepo",
        namespace: "skills",
        description: "Install one or more skills from a GitHub repository, git URL, owner/repo shorthand, or local repo path by discovering SKILL.md files.",
        input_schema: skills_install_from_repo_input_schema,
        output_schema: generic_state_output_schema,
        mutating: true,
        concurrency_safe: false,
        runtime_modes: ALL_APP_RUNTIME_MODES,
        visibility: ActionVisibility::CompatOnly,
    },
    ActionDescriptor {
        action: "skills.uninstall",
        namespace: "skills",
        description: "Uninstall a user or workspace skill by deleting its managed skill directory. Built-in skills are refused.",
        input_schema: skills_uninstall_input_schema,
        output_schema: generic_state_output_schema,
        mutating: true,
        concurrency_safe: false,
        runtime_modes: ALL_APP_RUNTIME_MODES,
        visibility: ActionVisibility::CompatOnly,
    },
    ActionDescriptor {
        action: "skills.manage",
        namespace: "skills",
        description: "Run one explicit skill management operation such as installing skills from a repository or uninstalling a managed skill. Use this consolidated action instead of skills.installFromRepo or skills.uninstall compatibility actions.",
        input_schema: skills_manage_input_schema,
        output_schema: generic_state_output_schema,
        mutating: true,
        concurrency_safe: false,
        runtime_modes: ALL_APP_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
    ActionDescriptor {
        action: "generation.job.list",
        namespace: "generation.job",
        description: "List recent media generation jobs and status. Use this for user questions like 图片生成进度, video generation progress, latest media job status, or to find the newest image/video job before answering. Do not start a new generation when the user only asks for progress.",
        input_schema: generation_job_list_input_schema,
        output_schema: media_output_schema,
        mutating: false,
        concurrency_safe: true,
        runtime_modes: REDCLAW_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
    ActionDescriptor {
        action: "generation.job.get",
        namespace: "generation.job",
        description: "Read one media generation job by jobId, including current status, progress, attempt details, recent events, and generated artifacts. Use this before telling the user a job failed, is still running, or completed.",
        input_schema: generation_job_get_input_schema,
        output_schema: media_output_schema,
        mutating: false,
        concurrency_safe: true,
        runtime_modes: REDCLAW_RUNTIME_MODES,
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
        description: "Generate videos with the configured provider. Upstream video generation is capped at 15 seconds per segment; for longer final videos, pass durationSeconds > 15 or explicit videoSegments and the media runtime will create a video_sequence job, generate <=15 second segments, concatenate them, and return one final video asset.",
        input_schema: video_generate_input_schema,
        output_schema: media_output_schema,
        mutating: true,
        concurrency_safe: true,
        runtime_modes: REDCLAW_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
    ActionDescriptor {
        action: "media.videoRetalk",
        namespace: "media",
        description: "Create a digital-human lip-sync video through the fixed VideoRetalk API. Requires remote video_url and audio_url plus billing fields durationSeconds and resolution; completion saves the output video into the media library.",
        input_schema: media_video_retalk_input_schema,
        output_schema: media_output_schema,
        mutating: true,
        concurrency_safe: true,
        runtime_modes: REDCLAW_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
    ActionDescriptor {
        action: "video.analyze",
        namespace: "video_analysis",
        description: "Analyze an attached video's visual content, scenes, highlights, or edit strategy by delegating to the locked Video Analysis Agent. Do not use for subtitles, captions, transcripts, SRT, VTT, or ASR; use media.transcribe for those.",
        input_schema: video_analyze_input_schema,
        output_schema: media_output_schema,
        mutating: false,
        concurrency_safe: true,
        runtime_modes: REDCLAW_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
    ActionDescriptor {
        action: "media.edit",
        namespace: "media",
        description: "Edit an existing local video with controlled ffmpeg operations and register the outputs in the media library. Use this instead of shell for user requests to cut, trim, split, concatenate, mute, speed-change, crop, or export an uploaded video. Reuse the already resolved attachment sourcePath/toolPath; do not search for the file again before editing.",
        input_schema: media_edit_input_schema,
        output_schema: media_output_schema,
        mutating: true,
        concurrency_safe: false,
        runtime_modes: REDCLAW_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
    ActionDescriptor {
        action: "media.transcribe",
        namespace: "media",
        description: "Extract audio from an existing local video/audio file and generate a transcript or subtitle file. Use for subtitle recognition, captions, SRT, VTT, ASR, spoken-text extraction, subtitle overlay, captioned exports, or semantic video cuts that need timed text.",
        input_schema: media_transcribe_input_schema,
        output_schema: media_output_schema,
        mutating: true,
        concurrency_safe: false,
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
        action: "workspace.inspectImage",
        namespace: "workspace",
        description: "Inspect one workspace-relative local image file and return dimensions, mime type, byte size, hash, and optionally a small data URL.",
        input_schema: fs_workspace_inspect_image_input_schema,
        output_schema: file_system_output_schema,
        mutating: false,
        concurrency_safe: true,
        runtime_modes: ALL_FILE_SYSTEM_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
    ActionDescriptor {
        action: "workspace.createDirectory",
        namespace: "workspace",
        description: "Create one workspace-relative directory, including missing parents. Use for project folders and other long-lived workspace artifacts.",
        input_schema: fs_workspace_create_directory_input_schema,
        output_schema: file_system_output_schema,
        mutating: true,
        concurrency_safe: false,
        runtime_modes: ALL_FILE_SYSTEM_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
    ActionDescriptor {
        action: "workspace.write",
        namespace: "workspace",
        description: "Write one UTF-8 text file inside the workspace, creating parent directories as needed. Use for project manifests, drafts, plans, transcripts, and indexes that should live as user-managed project files.",
        input_schema: fs_workspace_write_input_schema,
        output_schema: file_system_output_schema,
        mutating: true,
        concurrency_safe: false,
        runtime_modes: ALL_FILE_SYSTEM_RUNTIME_MODES,
        visibility: ActionVisibility::Model,
    },
    ActionDescriptor {
        action: "workspace.patch",
        namespace: "workspace",
        description: "Patch one existing UTF-8 workspace file using exact oldText/newText replacements. Each edit must match exactly once unless replaceAll is true.",
        input_schema: fs_workspace_patch_input_schema,
        output_schema: file_system_output_schema,
        mutating: true,
        concurrency_safe: false,
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
        description: "Read one advisor/shared knowledge file or one indexed block from a registered document source. Visual blocks from images or scanned PDF pages may include visualSource, visualEvidence, and visualSummary.",
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
        description: "Search advisor knowledge, shared knowledge, or a registered document source by text query, including visual manifest projections for images and scanned PDF pages.",
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
    match runtime_mode.unwrap_or("team").trim() {
        "" | "default" | "chat" | "chatroom" => "team",
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
        let candidate = if *item == "default" || *item == "chatroom" {
            "team"
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
        "workflow" => APP_CLI_ACTIONS,
        "resource" => REDBOX_FS_ACTIONS,
        "editor" => REDBOX_EDITOR_ACTIONS,
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
        "workflow" => APP_CLI_ACTIONS,
        "resource" => REDBOX_FS_ACTIONS,
        "editor" => REDBOX_EDITOR_ACTIONS,
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
        "Operate" => Some(ToolDescriptor {
            name: "Operate",
            description: REDBOX_DESCRIPTION,
            kind: ToolKind::AppCli,
            requires_approval: false,
            concurrency_safe: false,
            output_budget_chars: 20_000,
        }),
        "tool_search" => Some(ToolDescriptor {
            name: "tool_search",
            description: TOOL_SEARCH_DESCRIPTION,
            kind: ToolKind::RuntimeControl,
            requires_approval: false,
            concurrency_safe: true,
            output_budget_chars: 24_000,
        }),
        "workflow" => Some(ToolDescriptor {
            name: "workflow",
            description: APP_CLI_DESCRIPTION,
            kind: ToolKind::AppCli,
            requires_approval: false,
            concurrency_safe: false,
            output_budget_chars: 20_000,
        }),
        "shell" => Some(ToolDescriptor {
            name: "shell",
            description: "Run a real shell command in the user's environment with policy-controlled access. Supports shell syntax such as pipes, redirects, command substitution, glob expansion, and command chaining. Prefer structured Operate actions such as media.edit for supported app workflows; use shell for broad host command work and local tools.",
            kind: ToolKind::Shell,
            requires_approval: false,
            concurrency_safe: false,
            output_budget_chars: 40_000,
        }),
        "write_stdin" => Some(ToolDescriptor {
            name: "write_stdin",
            description: "Write characters to a running shell execution or poll recent output without writing. Use only with an executionId returned by shell.",
            kind: ToolKind::Shell,
            requires_approval: false,
            concurrency_safe: false,
            output_budget_chars: 40_000,
        }),
        "bash" => Some(ToolDescriptor {
            name: "bash",
            description: "Read-only shell inspection inside currentSpaceRoot. Supports pwd, ls, find, rg, cat, head, tail, sed, wc, jq, and read-only git commands. Do not use this for real host CLI execution, PATH checks, curl, which, type, command -v, node, npm, pnpm, or tool-specific CLIs; use Operate(resource=\"cli_runtime\", operation=\"inspect|diagnose|run\") instead.",
            kind: ToolKind::Bash,
            requires_approval: false,
            concurrency_safe: true,
            output_budget_chars: 20_000,
        }),
        "query" => Some(ToolDescriptor {
            name: "query",
            description: "Disabled legacy alias for app queries. Use Read/List/Search/Write/Operate instead.",
            kind: ToolKind::AppQuery,
            requires_approval: false,
            concurrency_safe: true,
            output_budget_chars: 12_000,
        }),
        "resource" => Some(ToolDescriptor {
            name: "resource",
            description: "Unified structured file access for workspace and advisor/member knowledge. Prefer explicit actions such as workspace.list, workspace.read, workspace.createDirectory, workspace.write, workspace.patch, workspace.search, knowledge.list, knowledge.read, and knowledge.search.",
            kind: ToolKind::FileSystem,
            requires_approval: false,
            concurrency_safe: true,
            output_budget_chars: 20_000,
        }),
        "knowledge_glob" => Some(ToolDescriptor {
            name: "knowledge_glob",
            description: "Disabled legacy alias for advisor/member knowledge listing. Use List(path=\"knowledge://\") instead.",
            kind: ToolKind::FileSystem,
            requires_approval: false,
            concurrency_safe: true,
            output_budget_chars: 16_000,
        }),
        "knowledge_grep" => Some(ToolDescriptor {
            name: "knowledge_grep",
            description: "Disabled legacy alias for advisor/member knowledge search. Use Search(path=\"knowledge://\", query=\"...\") instead.",
            kind: ToolKind::FileSystem,
            requires_approval: false,
            concurrency_safe: true,
            output_budget_chars: 18_000,
        }),
        "knowledge_read" => Some(ToolDescriptor {
            name: "knowledge_read",
            description: "Disabled legacy alias for advisor/member knowledge read. Use Read(path=\"knowledge://...\") instead.",
            kind: ToolKind::FileSystem,
            requires_approval: false,
            concurrency_safe: true,
            output_budget_chars: 20_000,
        }),
        "profile_doc" => Some(ToolDescriptor {
            name: "profile_doc",
            description: "Disabled legacy alias for durable AI profile doc operations. Use Operate(resource=\"profile\", operation=\"list|get|update\") instead.",
            kind: ToolKind::ProfileDoc,
            requires_approval: false,
            concurrency_safe: false,
            output_budget_chars: 16_000,
        }),
        "mcp" => Some(ToolDescriptor {
            name: "mcp",
            description: "Disabled legacy alias for MCP management. Use Operate(resource=\"mcp\", operation=\"list|get|install|verify|run\") instead.",
            kind: ToolKind::Mcp,
            requires_approval: false,
            concurrency_safe: true,
            output_budget_chars: 20_000,
        }),
        "skill" => Some(ToolDescriptor {
            name: "skill",
            description: "Disabled legacy alias for skill runtime and AI-role management. Use Operate(resource=\"skills\", operation=\"list|invoke\") instead.",
            kind: ToolKind::Skill,
            requires_approval: false,
            concurrency_safe: false,
            output_budget_chars: 12_000,
        }),
        "runtime_control" => Some(ToolDescriptor {
            name: "runtime_control",
            description: "Disabled legacy alias for runtime/session/task/background control. Use Operate(resource=\"runtime\", operation=\"list|get|create|resume|cancel\") instead.",
            kind: ToolKind::RuntimeControl,
            requires_approval: false,
            concurrency_safe: false,
            output_budget_chars: 20_000,
        }),
        "editor" => Some(ToolDescriptor {
            name: "editor",
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
        "Operate" => Some(redbox_tool_schema(None)),
        "tool_search" => Some(tool_search_schema()),
        "workflow" => Some(build_action_tool_schema(
            "workflow",
            APP_CLI_DESCRIPTION,
            &action_descriptors_for_tool("workflow", runtime_mode, ActionVisibility::Model),
        )),
        "shell" => Some(json!({
            "type": "function",
            "function": {
                "name": "shell",
                "description": "Run a shell command and return its output or an execution id for polling. Supports shell syntax such as pipes, redirects, command substitution, glob expansion, and command chaining. Prefer structured Operate actions such as media.edit for video/audio editing workflows.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "command": { "type": "string", "description": "Shell command to execute in the user's default shell." },
                        "cwd": { "type": "string", "description": "Working directory for the command." },
                        "workdir": { "type": "string", "description": "Codex-style alias for cwd." },
                        "maxChars": { "type": "integer", "minimum": 200, "maximum": 40000, "description": "Maximum output characters." },
                        "max_output_tokens": { "type": "integer", "minimum": 200, "maximum": 40000, "description": "Codex-style output budget alias. Interpreted as a character cap by this runtime." },
                        "usePty": { "type": "boolean", "description": "Use interactive background execution for long-running commands." },
                        "tty": { "type": "boolean", "description": "Codex-style alias for usePty." },
                        "login": { "type": "boolean", "description": "Run with login shell semantics. Defaults to true." },
                        "executionMode": { "type": "string", "enum": ["managed", "host_compatible", "unrestricted"], "description": "Optional execution safety mode. Use unrestricted only after explicit user approval." },
                        "env": {
                            "type": "object",
                            "additionalProperties": { "type": "string" },
                            "description": "Optional environment variables for this command."
                        },
                        "executionId": { "type": "string", "description": "Poll a previous async execution by its ID instead of running a new command." }
                    },
                    "required": [],
                    "additionalProperties": false
                }
            }
        })),
        "write_stdin" => Some(json!({
            "type": "function",
            "function": {
                "name": "write_stdin",
                "description": "Write characters to an existing shell execution and return recent output. Passing empty chars polls without writing.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "executionId": { "type": "string", "description": "Execution id returned by shell." },
                        "session_id": { "type": "string", "description": "Codex-style alias for executionId." },
                        "chars": { "type": "string", "description": "Bytes/text to write to stdin. Omit or pass empty string to poll." },
                        "text": { "type": "string", "description": "Compatibility alias for chars." },
                        "appendNewline": { "type": "boolean", "description": "Append one newline after chars." },
                        "closeStdin": { "type": "boolean", "description": "Close stdin after writing." },
                        "maxChars": { "type": "integer", "minimum": 200, "maximum": 40000, "description": "Maximum output characters." },
                        "max_output_tokens": { "type": "integer", "minimum": 200, "maximum": 40000, "description": "Codex-style output budget alias. Interpreted as a character cap by this runtime." }
                    },
                    "required": [],
                    "additionalProperties": false
                }
            }
        })),
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
        "query" => Some(json!({
            "type": "function",
            "function": {
                "name": "query",
                "description": "Disabled legacy alias for app queries. Use Read/List/Search/Write/Operate instead.",
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
                                "redclaw.profile.completeStyleDefinition",
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
        "resource" => Some(build_action_tool_schema(
            "resource",
            "Unified structured file access for workspace and advisor/member knowledge. Prefer explicit actions such as workspace.list, workspace.read, workspace.createDirectory, workspace.write, workspace.patch, workspace.search, knowledge.list, knowledge.read, and knowledge.search.",
            &action_descriptors_for_tool("resource", runtime_mode, ActionVisibility::Model),
        )),
        "knowledge_glob" => Some(json!({
            "type": "function",
            "function": {
                "name": "knowledge_glob",
                "description": "Disabled legacy alias for advisor/member knowledge listing. Use List(path=\"knowledge://\") instead.",
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
                "description": "Disabled legacy alias for advisor/member knowledge search. Use Search(path=\"knowledge://\", query=\"...\") instead.",
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
                "description": "Disabled legacy alias for advisor/member knowledge read. Use Read(path=\"knowledge://...\") instead.",
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
        "profile_doc" => Some(json!({
            "type": "function",
            "function": {
                "name": "profile_doc",
                "description": "Disabled legacy alias for durable AI profile doc operations. Use Operate(resource=\"profile\", operation=\"list|get|update\") instead.",
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
        "mcp" => Some(json!({
            "type": "function",
            "function": {
                "name": "mcp",
                "description": "Disabled legacy alias for MCP management. Use Operate(resource=\"mcp\", operation=\"list|get|install|verify|run\") instead.",
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
        "skill" => Some(json!({
            "type": "function",
            "function": {
                "name": "skill",
                "description": "Disabled legacy alias for skill runtime and AI-role management. Use Operate(resource=\"skills\", operation=\"list|run\") instead.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "action": {
                            "type": "string",
                            "enum": ["list", "invoke", "create", "save", "enable", "disable", "market_install", "ai_roles_list", "detect_protocol", "test_connection"]
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
        "runtime_control" => Some(json!({
            "type": "function",
            "function": {
                "name": "runtime_control",
                "description": "Disabled legacy alias for runtime/session/task/background control. Use Operate(resource=\"runtime\", operation=\"list|get|create|resume|cancel\") instead.",
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
        "editor" => Some(build_action_tool_schema(
            "editor",
            REDBOX_EDITOR_DESCRIPTION,
            &action_descriptors_for_tool("editor", runtime_mode, ActionVisibility::Model),
        )),
        _ => None,
    }
}

pub fn schema_for_tool_from_action_descriptors(
    name: &str,
    descriptors: &[ActionDescriptor],
) -> Option<Value> {
    match name {
        "workflow" => Some(build_action_tool_schema(
            "workflow",
            APP_CLI_DESCRIPTION,
            descriptors,
        )),
        "resource" => Some(build_action_tool_schema(
            "resource",
            "Unified structured file access for workspace and advisor/member knowledge. Prefer explicit actions such as workspace.list, workspace.read, workspace.createDirectory, workspace.write, workspace.patch, workspace.search, knowledge.list, knowledge.read, and knowledge.search.",
            descriptors,
        )),
        "editor" => Some(build_action_tool_schema(
            "editor",
            REDBOX_EDITOR_DESCRIPTION,
            descriptors,
        )),
        "Operate" => Some(redbox_tool_schema(Some(descriptors))),
        "tool_search" => Some(tool_search_schema()),
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
        let schema = schema_for_tool_for_runtime_mode("workflow", Some("redclaw"))
            .expect("workflow schema should exist");
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
        let schema = schema_for_tool_for_runtime_mode("workflow", Some("diagnostics"))
            .expect("diagnostics schema should exist");
        let actions = schema["function"]["parameters"]["properties"]["action"]["enum"]
            .as_array()
            .expect("action enum");
        let actions = actions.iter().filter_map(Value::as_str).collect::<Vec<_>>();
        assert!(actions.contains(&"runtime.query"));
        assert!(actions.contains(&"taskBrief.goal"));
        assert!(!actions.contains(&"cli_runtime.detect"));
        assert!(!actions.contains(&"cli_runtime.discover"));
        assert!(!actions.contains(&"cli_runtime.execution.get"));
        assert!(actions.contains(&"mcp.inspect"));
        assert!(actions.contains(&"mcp.manage"));
        assert!(actions.contains(&"runner.manage"));
        assert!(!actions.contains(&"redclaw.runner.status"));
        assert!(!actions.contains(&"redclaw.runner.start"));
        assert!(!actions.contains(&"redclaw.runner.stop"));
        assert!(!actions.contains(&"redclaw.runner.setConfig"));
        assert!(!actions.contains(&"mcp.get"));
        assert!(!actions.contains(&"mcp.add"));
        assert!(!actions.contains(&"mcp.remove"));
        assert!(!actions.contains(&"mcp.discoverLocal"));
        assert!(!actions.contains(&"mcp.importLocal"));
        assert!(!actions.contains(&"mcp.save"));
        assert!(!actions.contains(&"mcp.test"));
        assert!(!actions.contains(&"mcp.tools"));
        assert!(!actions.contains(&"mcp.listResourceTemplates"));
        assert!(!actions.contains(&"manuscripts.writeCurrent"));
    }

    #[test]
    fn shell_schema_exposes_broad_shell_and_stdin_control() {
        let shell = schema_for_tool_for_runtime_mode("shell", Some("team"))
            .expect("shell schema should exist");
        let description = shell
            .pointer("/function/description")
            .and_then(Value::as_str)
            .expect("shell description");
        assert!(description.contains("pipes"));
        assert!(description.contains("media.edit"));
        assert!(shell
            .pointer("/function/parameters/properties/workdir")
            .is_some());
        assert!(shell
            .pointer("/function/parameters/properties/max_output_tokens")
            .is_some());

        let write_stdin = schema_for_tool_for_runtime_mode("write_stdin", Some("team"))
            .expect("write_stdin schema should exist");
        assert_eq!(
            write_stdin
                .pointer("/function/name")
                .and_then(Value::as_str),
            Some("write_stdin")
        );
        assert!(write_stdin
            .pointer("/function/parameters/properties/session_id")
            .is_some());
    }

    #[test]
    fn team_schema_exposes_mcp_setup_actions() {
        let schema = schema_for_tool_for_runtime_mode("workflow", Some("team"))
            .expect("team schema should exist");
        let actions = schema["function"]["parameters"]["properties"]["action"]["enum"]
            .as_array()
            .expect("action enum")
            .iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>();

        for action in ["mcp.inspect", "mcp.manage"] {
            assert!(actions.contains(&action), "{action}");
        }
        for action in [
            "mcp.list",
            "mcp.get",
            "mcp.sessions",
            "mcp.listTools",
            "mcp.tools",
            "mcp.listResources",
            "mcp.listResourceTemplates",
            "mcp.add",
            "mcp.remove",
            "mcp.enable",
            "mcp.disable",
            "mcp.discoverLocal",
            "mcp.importLocal",
            "mcp.save",
            "mcp.test",
            "mcp.oauthStatus",
        ] {
            assert!(!actions.contains(&action), "{action}");
        }
    }

    #[test]
    fn team_schema_exposes_codex_plugin_actions() {
        let schema = schema_for_tool_for_runtime_mode("workflow", Some("team"))
            .expect("team schema should exist");
        let actions = schema["function"]["parameters"]["properties"]["action"]["enum"]
            .as_array()
            .expect("action enum")
            .iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>();

        for action in ["plugins.discover", "plugins.install"] {
            assert!(actions.contains(&action), "{action}");
        }
        assert!(!actions.contains(&"plugins.list"));
        for action in ["skills.inspect", "skills.invoke"] {
            assert!(actions.contains(&action), "{action}");
        }
        assert!(actions.contains(&"skills.manage"));
        for action in [
            "plugins.connectors",
            "plugins.marketplace",
            "plugins.codexMarketplace",
            "plugins.discoverLocal",
            "plugins.installCodex",
            "plugins.requestInstall",
            "skills.installFromRepo",
            "skills.uninstall",
            "skills.list",
            "skills.read",
        ] {
            assert!(!actions.contains(&action), "{action}");
        }

        let operate = schema_for_tool_for_runtime_mode("Operate", Some("team"))
            .expect("Operate schema should exist");
        let resources = operate
            .pointer("/function/parameters/properties/resource/enum")
            .and_then(Value::as_array)
            .expect("resource enum");
        assert!(resources.contains(&json!("plugins")));
        let operations = operate
            .pointer("/function/parameters/properties/operation/enum")
            .and_then(Value::as_array)
            .expect("operation enum");
        assert!(operations.contains(&json!("install")));
        assert!(operations.contains(&json!("verify")));
    }

    #[test]
    fn image_generation_schema_exposes_media_generation_actions() {
        let schema = schema_for_tool_for_runtime_mode("workflow", Some("image-generation"))
            .expect("image-generation schema should exist");
        let actions = schema["function"]["parameters"]["properties"]["action"]["enum"]
            .as_array()
            .expect("action enum")
            .iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>();

        assert!(actions.contains(&"image.generate"));
        assert!(actions.contains(&"video.generate"));
        assert!(actions.contains(&"media.videoRetalk"));
        assert!(actions.contains(&"video.analyze"));
        assert!(actions.contains(&"media.edit"));
        assert!(actions.contains(&"media.transcribe"));
        assert!(actions.contains(&"voice.clone"));
        assert!(actions.contains(&"voice.bindAsset"));
        assert!(actions.contains(&"voice.speech"));
        assert!(!actions.contains(&"tools.search"));
    }

    #[test]
    fn redclaw_schema_hides_internal_runtime_task_actions() {
        let schema = schema_for_tool_for_runtime_mode("workflow", Some("redclaw"))
            .expect("redclaw schema should exist");
        let actions = schema["function"]["parameters"]["properties"]["action"]["enum"]
            .as_array()
            .expect("action enum")
            .iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>();
        assert!(actions.contains(&"task.read"));
        assert!(!actions.contains(&"task.preview"));
        assert!(!actions.contains(&"task.list"));
        assert!(!actions.contains(&"redclaw.task.preview"));
        assert!(!actions.contains(&"redclaw.task.list"));
        assert!(!actions.contains(&"cli_runtime.inspect"));
        assert!(!actions.contains(&"runtime.tasks.list"));
        assert!(!actions.contains(&"cli_runtime.detect"));
    }

    #[test]
    fn redbox_fs_schema_uses_explicit_action_variants() {
        let schema = schema_for_tool_for_runtime_mode("resource", Some("team"))
            .expect("resource schema should exist");
        let actions = schema["function"]["parameters"]["properties"]["action"]["enum"]
            .as_array()
            .expect("action enum")
            .iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>();
        assert!(actions.contains(&"workspace.list"));
        assert!(actions.contains(&"workspace.read"));
        assert!(actions.contains(&"workspace.inspectImage"));
        assert!(actions.contains(&"workspace.createDirectory"));
        assert!(actions.contains(&"workspace.write"));
        assert!(actions.contains(&"workspace.patch"));
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
            ("Operate", Some("redclaw")),
            ("workflow", Some("redclaw")),
            ("resource", Some("wander")),
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

        let redbox = schema_for_tool_for_runtime_mode("Operate", Some("redclaw"))
            .expect("Operate schema should exist");
        assert_eq!(
            redbox.pointer("/function/parameters/properties/resource/enum/0"),
            Some(&json!("manuscript"))
        );
        let resources = redbox
            .pointer("/function/parameters/properties/resource/enum")
            .and_then(Value::as_array)
            .expect("resource enum should exist");
        assert!(resources.contains(&json!("voice")));
        let operations = redbox
            .pointer("/function/parameters/properties/operation/enum")
            .and_then(Value::as_array)
            .expect("operation enum should exist");
        assert!(operations.contains(&json!("speech")));
        assert!(redbox
            .pointer("/function/parameters/properties/input/properties/voiceId")
            .is_some());
        assert_eq!(
            redbox.pointer("/function/parameters/properties/input/properties/speed/maximum"),
            Some(&json!(2.0))
        );
        assert!(redbox
            .pointer("/function/parameters/properties/input/properties/emotion/enum")
            .and_then(Value::as_array)
            .expect("emotion enum")
            .contains(&json!("happy")));
        assert_eq!(
            redbox.pointer(
                "/function/parameters/properties/input/properties/segments/items/properties/speed/maximum"
            ),
            Some(&json!(2.0))
        );
        assert!(redbox
            .pointer(
                "/function/parameters/properties/input/properties/segments/items/properties/emotion/enum"
            )
            .and_then(Value::as_array)
            .expect("segment emotion enum")
            .contains(&json!("whisper")));
        assert!(redbox
            .pointer("/function/parameters/properties/input/properties/waitForCompletion")
            .is_some());
        assert_eq!(
            redbox.pointer("/function/parameters/properties/input/properties/aspectRatio/enum/1"),
            Some(&json!("3:4"))
        );
    }

    #[test]
    fn tool_action_family_summary_lists_namespaces() {
        let summary =
            tool_action_family_summary("workflow", Some("redclaw")).expect("summary should exist");
        assert!(summary.contains("memory"));
        assert!(summary.contains("assets"));
        assert!(summary.contains("manuscripts"));
        assert!(summary.contains("team.session"));
        assert!(summary.contains("team.member"));
        assert!(summary.contains("team.task"));
        let fs_summary =
            tool_action_family_summary("resource", Some("team")).expect("summary should exist");
        assert!(fs_summary.contains("workspace"));
        assert!(fs_summary.contains("knowledge"));
    }

    #[test]
    fn app_cli_model_actions_expose_assets_not_legacy_subjects() {
        let actions =
            action_descriptors_for_tool("workflow", Some("redclaw"), ActionVisibility::Model)
                .into_iter()
                .map(|descriptor| descriptor.action)
                .collect::<Vec<_>>();

        assert!(actions.contains(&"assets.search"));
        assert!(actions.contains(&"assets.get"));
        assert!(actions.contains(&"assets.manage"));
        assert!(!actions.contains(&"assets.create"));
        assert!(!actions.contains(&"assets.update"));
        assert!(actions.contains(&"assets.generateCharacterCard"));
        assert!(!actions.contains(&"assets.categories.create"));
        assert!(!actions.contains(&"subjects.search"));
        assert!(!actions.contains(&"subjects.get"));
    }

    #[test]
    fn app_cli_full_catalog_keeps_high_noise_groups_compressed() {
        let model_actions = APP_CLI_ACTIONS
            .iter()
            .copied()
            .filter(|descriptor| descriptor.visibility == ActionVisibility::Model)
            .collect::<Vec<_>>();
        let plugin_skill_mcp = model_actions
            .iter()
            .filter(|descriptor| {
                descriptor.action.starts_with("plugins.")
                    || descriptor.action.starts_with("skills.")
                    || descriptor.action.starts_with("mcp.")
            })
            .count();
        let memory_redclaw = model_actions
            .iter()
            .filter(|descriptor| {
                descriptor.action.starts_with("memory.")
                    || descriptor.action.starts_with("profile.")
                    || descriptor.action.starts_with("task.")
                    || descriptor.action.starts_with("runner.")
                    || descriptor.action.starts_with("redclaw.profile.")
                    || descriptor.action.starts_with("redclaw.task.")
                    || descriptor.action.starts_with("redclaw.runner.")
            })
            .count();

        assert!(
            plugin_skill_mcp <= 8,
            "Plugins/Skills/MCP full catalog grew to {plugin_skill_mcp}"
        );
        assert!(
            memory_redclaw <= 8,
            "Memory/RedClaw full catalog grew to {memory_redclaw}"
        );
    }

    #[test]
    fn app_cli_schema_exposes_consolidated_team_control_action() {
        let schema = schema_for_tool_for_runtime_mode("workflow", Some("redclaw"))
            .expect("workflow schema should exist");
        let actions = schema
            .pointer("/function/parameters/properties/action/enum")
            .and_then(Value::as_array)
            .expect("action enum should exist");
        assert!(actions.iter().any(|item| item == "team.control"));
        for action in [
            "team.session.create",
            "team.member.spawn",
            "team.member.match",
            "team.member.rename",
            "team.member.shutdown",
            "team.member.interrupt",
            "team.task.create",
            "team.message.send",
            "team.report.request",
            "team.report.submit",
            "team.artifact.attach",
            "team.blocker.raise",
        ] {
            assert!(!actions.iter().any(|item| item == action), "{action}");
        }
    }

    #[test]
    fn redclaw_schema_exposes_web_fetch_and_mcp_inspect_actions() {
        let schema = schema_for_tool_for_runtime_mode("workflow", Some("redclaw"))
            .expect("workflow schema should exist");
        let actions = schema
            .pointer("/function/parameters/properties/action/enum")
            .and_then(Value::as_array)
            .expect("action enum should exist");
        for action in ["web.fetch", "mcp.inspect", "mcp.manage"] {
            assert!(actions.iter().any(|item| item == action), "{action}");
        }
        for action in [
            "mcp.list",
            "mcp.get",
            "mcp.listTools",
            "mcp.tools",
            "mcp.add",
            "mcp.remove",
        ] {
            assert!(!actions.iter().any(|item| item == action), "{action}");
        }
        for action in [
            "cli_runtime.inspect",
            "cli_runtime.diagnose",
            "cli_runtime.discover",
            "cli_runtime.install",
            "cli_runtime.execute",
            "cli_runtime.execution.get",
            "cli_runtime.execution.writeStdin",
        ] {
            assert!(
                !actions.iter().any(|item| item == action),
                "{action} should be hidden"
            );
        }
    }

    #[test]
    fn action_descriptor_lookup_exposes_output_schema() {
        let descriptor = action_descriptor_by_name(
            "workflow",
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
