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

pub fn descriptor_by_name(name: &str) -> Option<ToolDescriptor> {
    match name {
        "app_cli" => Some(ToolDescriptor {
            name: "app_cli",
            description: "Unified business command surface for advisors, chat sessions, spaces, subjects, manuscripts, theme/layout workflows, media, image generation, video generation, RedClaw, runtime/tasks/background control, settings, memory, skills, AI config, and MCP.",
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
            description: "Inspect and edit the current video/audio manuscript package with a script-first workflow. Video mode now prefers project_read + ffmpeg_edit + Remotion actions.",
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
        "app_cli" => Some(json!({
            "type": "function",
            "function": {
                "name": "app_cli",
                "description": "Unified business command surface for advisors, chat sessions, spaces, subjects, manuscripts, theme/layout workflows, media, image generation, video generation, RedClaw, runtime/tasks/background control, settings, memory, skills, AI config, and MCP.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "command": {
                            "type": "string",
                            "description": "Legacy free-form command string. Prefer `action` for stable high-frequency workflows."
                        },
                        "action": {
                            "type": "string",
                            "description": "Structured action id. Prefer this for manuscripts authoring flows such as `manuscripts.createProject` and `manuscripts.writeCurrent`."
                        },
                        "payload": { "type": "object" }
                    },
                    "anyOf": [
                        { "required": ["command"] },
                        { "required": ["action"] }
                    ],
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
        "redbox_editor" => Some(json!({
            "type": "function",
            "function": {
                "name": "redbox_editor",
                "description": "Inspect and edit the bound RedBox video/audio manuscript package. In video mode, prefer script_read -> script_update -> script_confirm -> project_read -> ffmpeg_edit -> remotion_* -> export.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "action": {
                            "type": "string",
                            "enum": [
                                "script_read",
                                "script_update",
                                "script_confirm",
                                "project_read",
                                "project-read",
                                "ffmpeg_edit",
                                "ffmpeg-edit",
                                "timeline_read",
                                "remotion_read",
                                "remotion-read",
                                "clips",
                                "selection_read",
                                "selection_set",
                                "selection-set",
                                "playhead_read",
                                "playhead_seek",
                                "playhead-seek",
                                "focus_clip",
                                "focus-clip",
                                "focus_item",
                                "focus-item",
                                "panel_open",
                                "panel-open",
                                "timeline_zoom_read",
                                "timeline-zoom-read",
                                "timeline_zoom_set",
                                "timeline-zoom-set",
                                "timeline_scroll_read",
                                "timeline-scroll-read",
                                "timeline_scroll_set",
                                "timeline-scroll-set",
                                "track_add",
                                "track-add",
                                "track_reorder",
                                "track-reorder",
                                "track_delete",
                                "track-delete",
                                "clip_add",
                                "clip-add",
                                "clip_insert_at_playhead",
                                "clip-insert-at-playhead",
                                "subtitle_add",
                                "subtitle-add",
                                "text_add",
                                "text-add",
                                "clip_update",
                                "clip-update",
                                "clip_move",
                                "clip-move",
                                "clip_toggle_enabled",
                                "clip-toggle-enabled",
                                "clip_delete",
                                "clip-delete",
                                "clip_split",
                                "clip-split",
                                "clip_duplicate",
                                "clip-duplicate",
                                "clip_replace_asset",
                                "clip-replace-asset",
                                "marker_add",
                                "marker-add",
                                "marker_update",
                                "marker-update",
                                "marker_delete",
                                "marker-delete",
                                "undo",
                                "redo",
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
                        "markerId": { "type": "string" },
                        "trackId": { "type": "string" },
                        "sceneId": { "type": "string" },
                        "track": { "type": "string" },
                        "content": { "type": "string" },
                        "intentSummary": { "type": "string" },
                        "text": { "type": "string" },
                        "name": { "type": "string" },
                        "operations": { "type": "array", "items": { "type": "object" } },
                        "previewTab": { "type": "string", "enum": ["preview", "motion", "script"] },
                        "renderMode": { "type": "string", "enum": ["full", "motion-layer"] },
                        "activePanel": { "type": "string" },
                        "drawerPanel": { "type": "string" },
                        "seconds": { "type": "number", "minimum": 0 },
                        "zoomPercent": { "type": "number", "minimum": 25, "maximum": 400 },
                        "scrollLeft": { "type": "number", "minimum": 0 },
                        "maxScrollLeft": { "type": "number", "minimum": 0 },
                        "order": { "type": "integer", "minimum": 0 },
                        "fromMs": { "type": "integer", "minimum": 0 },
                        "durationMs": { "type": "integer", "minimum": 1 },
                        "trimInMs": { "type": "integer", "minimum": 0 },
                        "trimOutMs": { "type": "integer", "minimum": 0 },
                        "enabled": { "type": "boolean" },
                        "frame": { "type": "integer", "minimum": 0 },
                        "color": { "type": "string" },
                        "label": { "type": "string" },
                        "direction": { "type": "string", "enum": ["up", "down"] },
                        "assetKind": { "type": "string" },
                        "subtitleStyle": { "type": "object" },
                        "textStyle": { "type": "object" },
                        "transitionStyle": { "type": "object" },
                        "splitRatio": { "type": "number", "minimum": 0.1, "maximum": 0.9 },
                        "instructions": { "type": "string" },
                        "scene": { "type": "object" },
                        "source": { "type": "string", "enum": ["user", "ai", "system"] },
                        "modelConfig": { "type": "object" }
                    },
                    "required": ["action"],
                    "additionalProperties": false
                }
            }
        })),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_cli_schema_supports_structured_action_field() {
        let schema = schema_for_tool("app_cli").expect("app_cli schema should exist");
        let parameters = &schema["function"]["parameters"];
        assert_eq!(
            parameters["properties"]["action"]["type"].as_str(),
            Some("string")
        );
        assert_eq!(
            parameters["anyOf"].as_array().map(|items| items.len()),
            Some(2)
        );
    }
}
