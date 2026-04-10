use serde::Serialize;
use serde_json::{json, Value};

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolKind {
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

pub fn descriptor_by_name(name: &str) -> Option<ToolDescriptor> {
    match name {
        "redbox_app_query" => Some(ToolDescriptor {
            name: "redbox_app_query",
            description:
                "Query app-managed RedBox data with one generic app tool. Prefer this over many specialized list/search tools.",
            kind: ToolKind::AppQuery,
            requires_approval: false,
            concurrency_safe: true,
            output_budget_chars: 12_000,
        }),
        "redbox_fs" => Some(ToolDescriptor {
            name: "redbox_fs",
            description: "Inspect files inside currentSpaceRoot with a single generic file tool. Use action=list before action=read.",
            kind: ToolKind::FileSystem,
            requires_approval: false,
            concurrency_safe: true,
            output_budget_chars: 20_000,
        }),
        "redbox_profile_doc" => Some(ToolDescriptor {
            name: "redbox_profile_doc",
            description:
                "Read or update RedClaw long-term profile docs (Agent.md, Soul.md, user.md, CreatorProfile.md). Update only when user requests durable profile changes.",
            kind: ToolKind::ProfileDoc,
            requires_approval: false,
            concurrency_safe: false,
            output_budget_chars: 16_000,
        }),
        "redbox_mcp" => Some(ToolDescriptor {
            name: "redbox_mcp",
            description: "Unified MCP management and call bridge.",
            kind: ToolKind::Mcp,
            requires_approval: false,
            concurrency_safe: true,
            output_budget_chars: 20_000,
        }),
        "redbox_skill" => Some(ToolDescriptor {
            name: "redbox_skill",
            description: "Unified skill and AI-role management entry.",
            kind: ToolKind::Skill,
            requires_approval: false,
            concurrency_safe: false,
            output_budget_chars: 12_000,
        }),
        "redbox_runtime_control" => Some(ToolDescriptor {
            name: "redbox_runtime_control",
            description: "Unified runtime/session/task/background control entry.",
            kind: ToolKind::RuntimeControl,
            requires_approval: false,
            concurrency_safe: false,
            output_budget_chars: 20_000,
        }),
        "redbox_editor" => Some(ToolDescriptor {
            name: "redbox_editor",
            description: "Inspect and edit the current video/audio manuscript package timeline.",
            kind: ToolKind::Editor,
            requires_approval: false,
            concurrency_safe: false,
            output_budget_chars: 24_000,
        }),
        _ => None,
    }
}

pub fn schema_for_tool(name: &str) -> Option<Value> {
    match name {
        "redbox_app_query" => Some(json!({
            "type": "function",
            "function": {
                "name": "redbox_app_query",
                "description": "Query app-managed RedBox data with one generic app tool. Prefer this over many specialized list/search tools.",
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
                                "redclaw.projects.list",
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
                "description": "Inspect files inside currentSpaceRoot with a single generic file tool. Use action=list before action=read.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "action": { "type": "string", "enum": ["list", "read"] },
                        "path": { "type": "string" },
                        "limit": { "type": "integer", "minimum": 1, "maximum": 50 },
                        "maxChars": { "type": "integer", "minimum": 200, "maximum": 20000 }
                    },
                    "required": ["action", "path"],
                    "additionalProperties": false
                }
            }
        })),
        "redbox_profile_doc" => Some(json!({
            "type": "function",
            "function": {
                "name": "redbox_profile_doc",
                "description": "Read or update RedClaw long-term profile docs (Agent.md, Soul.md, user.md, CreatorProfile.md). Update only when user requests durable profile changes.",
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
                "description": "Unified MCP management and call bridge.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "action": {
                            "type": "string",
                            "enum": ["list", "save", "test", "call", "discover_local", "import_local", "oauth_status"]
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
                "description": "Unified skill and AI-role management entry.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "action": {
                            "type": "string",
                            "enum": ["list", "create", "save", "enable", "disable", "market_install", "ai_roles_list", "detect_protocol", "test_connection", "fetch_models"]
                        },
                        "name": { "type": "string" },
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
                "description": "Unified runtime/session/task/background control entry.",
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
                                "session_bridge_status",
                                "session_bridge_list_sessions",
                                "session_bridge_get_session"
                            ]
                        },
                        "sessionId": { "type": "string" },
                        "message": { "type": "string" },
                        "modelConfig": { "type": "object" },
                        "taskId": { "type": "string" },
                        "limit": { "type": "integer", "minimum": 1, "maximum": 200 },
                        "payload": { "type": "object" }
                    },
                    "required": ["action"],
                    "additionalProperties": false
                }
            }
        })),
        "redbox_editor" => Some(json!({
            "type": "function",
            "function": {
                "name": "redbox_editor",
                "description": "Inspect and edit the bound RedBox video/audio manuscript package. Use timeline_read before mutating clips or tracks.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "action": {
                            "type": "string",
                            "enum": [
                                "timeline_read",
                                "clips",
                                "track_add",
                                "track-add",
                                "clip_add",
                                "clip-add",
                                "clip_update",
                                "clip-update",
                                "clip_delete",
                                "clip-delete",
                                "clip_split",
                                "clip-split",
                                "remotion_generate",
                                "remotion-generate",
                                "remotion_save",
                                "remotion-save",
                                "export"
                            ]
                        },
                        "filePath": { "type": "string" },
                        "kind": { "type": "string", "enum": ["video", "audio"] },
                        "assetId": { "type": "string" },
                        "clipId": { "type": "string" },
                        "track": { "type": "string" },
                        "order": { "type": "integer", "minimum": 0 },
                        "durationMs": { "type": "integer", "minimum": 1 },
                        "trimInMs": { "type": "integer", "minimum": 0 },
                        "trimOutMs": { "type": "integer", "minimum": 0 },
                        "enabled": { "type": "boolean" },
                        "splitRatio": { "type": "number", "minimum": 0.1, "maximum": 0.9 },
                        "instructions": { "type": "string" },
                        "scene": { "type": "object" }
                    },
                    "required": ["action"],
                    "additionalProperties": false
                }
            }
        })),
        _ => None,
    }
}
