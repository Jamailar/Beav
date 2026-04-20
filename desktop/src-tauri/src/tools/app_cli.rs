use serde_json::{json, Map, Value};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, State};

use crate::commands;
use crate::events::{
    emit_runtime_task_checkpoint_saved, emit_runtime_tool_partial, emit_runtime_tool_request,
    emit_runtime_tool_result,
};
use crate::helpers::{
    compose_markdown_with_frontmatter, ensure_manuscript_file_name,
    extract_markdown_frontmatter_block, get_draft_type_from_file_name, normalize_relative_path,
    strip_markdown_frontmatter, ARTICLE_DRAFT_EXTENSION, AUDIO_DRAFT_EXTENSION,
    POST_DRAFT_EXTENSION, VIDEO_DRAFT_EXTENSION,
};
use crate::interactive_runtime_shared::text_snippet;
use crate::persistence::with_store;
use crate::runtime::{McpServerRecord, SkillRecord};
use crate::skills::{find_catalog_skill_by_name, skill_allows_runtime_mode};
use crate::{make_id, now_iso, payload_field, payload_string, resolve_manuscript_path, AppState};

const IMAGE_PROMPT_OPTIMIZER_SKILL_NAME: &str = "image-prompt-optimizer";

pub struct AppCliExecutor<'a> {
    app: &'a AppHandle,
    state: &'a State<'a, AppState>,
    runtime_mode: &'a str,
    session_id: Option<&'a str>,
    tool_call_id: Option<&'a str>,
}

#[derive(Debug, Clone, Default)]
struct CliArgs {
    positionals: Vec<String>,
    options: Map<String, Value>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct VideoStoryboardShot {
    time: String,
    picture: String,
    sound: String,
    shot: String,
}

#[derive(Debug, Clone)]
struct BoundWritingSessionTarget {
    file_path: String,
    draft_type: String,
    title: Option<String>,
}

#[derive(Debug, Clone)]
struct AuthoringTargetPreference {
    preferred_extension: &'static str,
}

impl CliArgs {
    fn string(&self, keys: &[&str]) -> Option<String> {
        keys.iter().find_map(|key| match self.options.get(*key) {
            Some(Value::String(text)) => Some(text.clone()),
            Some(Value::Number(value)) => Some(value.to_string()),
            Some(Value::Bool(value)) => Some(value.to_string()),
            _ => None,
        })
    }

    fn i64(&self, keys: &[&str]) -> Option<i64> {
        keys.iter().find_map(|key| match self.options.get(*key) {
            Some(Value::Number(value)) => value.as_i64(),
            Some(Value::String(text)) => text.trim().parse::<i64>().ok(),
            _ => None,
        })
    }

    fn bool(&self, keys: &[&str]) -> Option<bool> {
        keys.iter().find_map(|key| match self.options.get(*key) {
            Some(Value::Bool(value)) => Some(*value),
            Some(Value::Number(value)) => Some(value.as_i64().unwrap_or_default() != 0),
            Some(Value::String(text)) => match text.trim().to_ascii_lowercase().as_str() {
                "true" | "1" | "yes" | "on" => Some(true),
                "false" | "0" | "no" | "off" => Some(false),
                _ => None,
            },
            _ => None,
        })
    }

    fn value(&self, keys: &[&str]) -> Option<Value> {
        keys.iter().find_map(|key| self.options.get(*key).cloned())
    }
}

impl<'a> AppCliExecutor<'a> {
    pub fn new(
        app: &'a AppHandle,
        state: &'a State<'a, AppState>,
        runtime_mode: &'a str,
        session_id: Option<&'a str>,
        tool_call_id: Option<&'a str>,
    ) -> Self {
        Self {
            app,
            state,
            runtime_mode,
            session_id,
            tool_call_id,
        }
    }

    pub fn execute(&self, arguments: &Value) -> Result<Value, String> {
        let command = payload_string(arguments, "command")
            .ok_or_else(|| "command is required".to_string())?;
        let payload = payload_field(arguments, "payload")
            .cloned()
            .unwrap_or_else(|| json!({}));
        let tokens = tokenize_command(&command);
        if tokens.is_empty() {
            return Err("command is empty".to_string());
        }

        match tokens[0].as_str() {
            "help" => Ok(help_response(tokens.get(1).map(String::as_str))),
            "advisors" => self.handle_advisors(&tokens[1..], &payload),
            "chat" => self.handle_chat(&tokens[1..], &payload),
            "spaces" => self.handle_spaces(&tokens[1..]),
            "subjects" => self.handle_subjects(&tokens[1..], &payload),
            "manuscripts" => self.handle_manuscripts(&tokens[1..], &payload),
            "media" => self.handle_media(&tokens[1..], &payload),
            "image" => self.handle_image(&tokens[1..], &payload),
            "video" => self.handle_video(&tokens[1..], &payload),
            "knowledge" => self.handle_knowledge(&tokens[1..], &payload),
            "work" => self.handle_work(&tokens[1..], &payload),
            "memory" => self.handle_memory(&tokens[1..], &payload),
            "redclaw" => self.handle_redclaw(&tokens[1..], &payload),
            "runtime" => self.handle_runtime(&tokens[1..], &payload),
            "settings" => self.handle_settings(&tokens[1..], &payload),
            "skills" => self.handle_skills(&tokens[1..], &payload),
            "mcp" => self.handle_mcp(&tokens[1..], &payload),
            "ai" => self.handle_ai(&tokens[1..], &payload),
            other => Err(format!("unsupported app_cli namespace: {other}")),
        }
    }

    fn handle_advisors(&self, tokens: &[String], payload: &Value) -> Result<Value, String> {
        let Some(action) = tokens.first().map(String::as_str) else {
            return Ok(help_response(Some("advisors")));
        };
        let args = parse_cli_args(&tokens[1..])?;
        match action {
            "list" => {
                let result = self.call_channel("advisors:list", json!({}))?;
                let mut advisors = result.as_array().cloned().unwrap_or_default();
                let limit = args
                    .i64(&["limit"])
                    .or_else(|| payload_field(payload, "limit").and_then(Value::as_i64))
                    .unwrap_or(20)
                    .clamp(1, 50) as usize;
                advisors.truncate(limit);
                Ok(json!({ "success": true, "advisors": advisors }))
            }
            "get" => {
                let advisor_id = args
                    .string(&["id", "advisor-id"])
                    .or_else(|| args.positionals.first().cloned())
                    .ok_or_else(|| "advisors get requires --id".to_string())?;
                let result = self.call_channel("advisors:list", json!({}))?;
                let advisor = result.as_array().and_then(|items| {
                    items.iter().find(|item| {
                        item.get("id")
                            .and_then(Value::as_str)
                            .map(|value| value == advisor_id)
                            .unwrap_or(false)
                    })
                });
                Ok(json!({ "success": advisor.is_some(), "advisor": advisor.cloned() }))
            }
            "list-templates" => self.call_channel("advisors:list-templates", json!({})),
            "create" => self.call_channel("advisors:create", merge_payload(&args.options, payload)),
            "update" => self.call_channel("advisors:update", merge_payload(&args.options, payload)),
            "delete" => self.call_channel(
                "advisors:delete",
                json!(args
                    .string(&["id", "advisor-id"])
                    .or_else(|| args.positionals.first().cloned())
                    .ok_or_else(|| "advisors delete requires --id".to_string())?),
            ),
            _ => Err(format!("unsupported advisors action: {action}")),
        }
    }

    fn handle_chat(&self, tokens: &[String], payload: &Value) -> Result<Value, String> {
        let Some(action) = tokens.first().map(String::as_str) else {
            return Ok(help_response(Some("chat")));
        };
        match action {
            "sessions" => {
                let sub = tokens.get(1).map(String::as_str).unwrap_or("list");
                let args = parse_cli_args(&tokens[2..])?;
                match sub {
                    "list" => {
                        let result = self.call_channel("chat:get-sessions", json!({}))?;
                        let mut sessions = result.as_array().cloned().unwrap_or_default();
                        let limit = args
                            .i64(&["limit"])
                            .or_else(|| payload_field(payload, "limit").and_then(Value::as_i64))
                            .unwrap_or(20)
                            .clamp(1, 50) as usize;
                        sessions.truncate(limit);
                        Ok(json!({ "success": true, "sessions": sessions }))
                    }
                    "get" => {
                        let session_id = args
                            .string(&["id", "session-id"])
                            .or_else(|| args.positionals.first().cloned())
                            .ok_or_else(|| "chat sessions get requires --id".to_string())?;
                        let result = self.call_channel("chat:get-sessions", json!({}))?;
                        let session = result.as_array().and_then(|items| {
                            items.iter().find(|item| {
                                item.get("id")
                                    .and_then(Value::as_str)
                                    .map(|value| value == session_id)
                                    .unwrap_or(false)
                            })
                        });
                        Ok(json!({ "success": session.is_some(), "session": session.cloned() }))
                    }
                    _ => Err(format!("unsupported chat sessions action: {sub}")),
                }
            }
            _ => Err(format!("unsupported chat action: {action}")),
        }
    }

    fn handle_spaces(&self, tokens: &[String]) -> Result<Value, String> {
        let Some(action) = tokens.first().map(String::as_str) else {
            return Ok(help_response(Some("spaces")));
        };
        let args = parse_cli_args(&tokens[1..])?;
        match action {
            "list" => self.call_channel("spaces:list", json!({})),
            "get" => {
                let id = args
                    .string(&["id", "space-id"])
                    .or_else(|| args.positionals.first().cloned())
                    .ok_or_else(|| "spaces get requires --id".to_string())?;
                let result = self.call_channel("spaces:list", json!({}))?;
                let space = result
                    .get("spaces")
                    .and_then(Value::as_array)
                    .and_then(|items| {
                        items.iter().find(|item| {
                            item.get("id")
                                .and_then(Value::as_str)
                                .map(|value| value == id)
                                .unwrap_or(false)
                        })
                    })
                    .cloned();
                Ok(json!({ "success": space.is_some(), "space": space }))
            }
            "create" => self.call_channel(
                "spaces:create",
                json!({
                    "name": args
                        .string(&["name"])
                        .or_else(|| args.positionals.first().cloned())
                        .ok_or_else(|| "spaces create requires --name".to_string())?
                }),
            ),
            "rename" => self.call_channel(
                "spaces:rename",
                json!({
                    "id": args
                        .string(&["id", "space-id"])
                        .or_else(|| args.positionals.first().cloned())
                        .ok_or_else(|| "spaces rename requires --id".to_string())?,
                    "name": args
                        .string(&["name"])
                        .or_else(|| args.positionals.get(1).cloned())
                        .ok_or_else(|| "spaces rename requires --name".to_string())?
                }),
            ),
            "switch" => self.call_channel(
                "spaces:switch",
                json!({
                    "spaceId": args
                        .string(&["id", "space-id"])
                        .or_else(|| args.positionals.first().cloned())
                        .ok_or_else(|| "spaces switch requires --id".to_string())?
                }),
            ),
            _ => Err(format!("unsupported spaces action: {action}")),
        }
    }

    fn handle_subjects(&self, tokens: &[String], payload: &Value) -> Result<Value, String> {
        let Some(action) = tokens.first().map(String::as_str) else {
            return Ok(help_response(Some("subjects")));
        };
        if action == "categories" {
            return self.handle_subject_categories(&tokens[1..], payload);
        }
        let args = parse_cli_args(&tokens[1..])?;
        match action {
            "list" => self.call_channel("subjects:list", json!({})),
            "get" => self.call_channel(
                "subjects:get",
                json!({
                    "id": args
                        .string(&["id"])
                        .or_else(|| args.positionals.first().cloned())
                        .ok_or_else(|| "subjects get requires --id".to_string())?
                }),
            ),
            "search" => self.call_channel(
                "subjects:search",
                json!({
                    "query": args
                        .string(&["query", "q"])
                        .or_else(|| {
                            if args.positionals.is_empty() {
                                None
                            } else {
                                Some(args.positionals.join(" "))
                            }
                        })
                        .unwrap_or_default(),
                    "categoryId": args.string(&["category-id", "category"])
                }),
            ),
            "create" => self.call_channel("subjects:create", merge_payload(&args.options, payload)),
            "update" => self.call_channel("subjects:update", merge_payload(&args.options, payload)),
            "delete" => self.call_channel(
                "subjects:delete",
                json!({
                    "id": args
                        .string(&["id"])
                        .or_else(|| args.positionals.first().cloned())
                        .ok_or_else(|| "subjects delete requires --id".to_string())?
                }),
            ),
            _ => Err(format!("unsupported subjects action: {action}")),
        }
    }

    fn handle_subject_categories(
        &self,
        tokens: &[String],
        payload: &Value,
    ) -> Result<Value, String> {
        let Some(action) = tokens.first().map(String::as_str) else {
            return Ok(help_response(Some("subjects")));
        };
        let args = parse_cli_args(&tokens[1..])?;
        match action {
            "list" => self.call_channel("subjects:categories:list", json!({})),
            "create" => self.call_channel(
                "subjects:categories:create",
                merge_payload(&args.options, payload),
            ),
            "update" => self.call_channel(
                "subjects:categories:update",
                merge_payload(&args.options, payload),
            ),
            "delete" => self.call_channel(
                "subjects:categories:delete",
                json!({
                    "id": args
                        .string(&["id"])
                        .or_else(|| args.positionals.first().cloned())
                        .ok_or_else(|| "subjects categories delete requires --id".to_string())?
                }),
            ),
            _ => Err(format!("unsupported subjects categories action: {action}")),
        }
    }

    fn handle_manuscripts(&self, tokens: &[String], payload: &Value) -> Result<Value, String> {
        let Some(action) = tokens.first().map(String::as_str) else {
            return Ok(help_response(Some("manuscripts")));
        };
        if action == "theme" {
            return self.handle_manuscript_theme(&tokens[1..], payload);
        }
        if action == "layout" {
            return self.handle_manuscript_layout(&tokens[1..], payload);
        }
        let args = parse_cli_args(&tokens[1..])?;
        match action {
            "list" => self.call_channel("manuscripts:list", json!({})),
            "read" => self.call_channel(
                "manuscripts:read",
                json!(args
                    .string(&["path"])
                    .or_else(|| args.positionals.first().cloned())
                    .ok_or_else(|| "manuscripts read requires --path".to_string())?),
            ),
            "write" | "save" => {
                let path = args
                    .string(&["path"])
                    .or_else(|| args.positionals.first().cloned())
                    .ok_or_else(|| "manuscripts write requires --path".to_string())?;
                let normalized_path = self.normalize_manuscript_target_path(&path);
                let mut merged = merge_payload(&args.options, payload);
                if let Some(object) = merged.as_object_mut() {
                    object.insert("path".to_string(), json!(normalized_path.clone()));
                    if !object.contains_key("content") {
                        object.insert(
                            "content".to_string(),
                            json!(args.string(&["content"]).unwrap_or_default()),
                        );
                    }
                }
                let maybe_proposal = self.maybe_queue_writing_manuscript_proposal(
                    &normalized_path,
                    payload_string(&merged, "content").unwrap_or_default(),
                    payload_field(&merged, "metadata"),
                )?;
                if let Some(result) = maybe_proposal {
                    return Ok(result);
                }
                self.call_channel("manuscripts:save", merged)
            }
            "write-html" | "save-html" => {
                let path = args
                    .string(&["path"])
                    .or_else(|| args.positionals.first().cloned())
                    .ok_or_else(|| "manuscripts save-html requires --path".to_string())?;
                let target = args
                    .string(&["target"])
                    .or_else(|| payload_string(payload, "target"))
                    .unwrap_or_else(|| "layout".to_string());
                let html = payload_string(payload, "html")
                    .or_else(|| args.string(&["html", "content"]))
                    .ok_or_else(|| "manuscripts save-html requires --html".to_string())?;
                self.call_channel(
                    "manuscripts:save-package-html",
                    json!({
                        "filePath": path,
                        "target": target,
                        "html": html
                    }),
                )
            }
            "write-template" | "save-template" => {
                let path = args
                    .string(&["path"])
                    .or_else(|| args.positionals.first().cloned())
                    .ok_or_else(|| "manuscripts save-template requires --path".to_string())?;
                let target = args
                    .string(&["target"])
                    .or_else(|| payload_string(payload, "target"))
                    .unwrap_or_else(|| "layout".to_string());
                let html = payload_string(payload, "html")
                    .or_else(|| args.string(&["html", "content"]))
                    .ok_or_else(|| "manuscripts save-template requires --html".to_string())?;
                self.call_channel(
                    "manuscripts:save-package-template",
                    json!({
                        "filePath": path,
                        "target": target,
                        "html": html
                    }),
                )
            }
            "create" => {
                let relative = args
                    .string(&["path"])
                    .or_else(|| args.positionals.first().cloned())
                    .ok_or_else(|| "manuscripts create requires --path".to_string())?;
                let normalized = self.normalize_manuscript_target_path(&relative);
                let (parent_path, name) = split_parent_and_name(&normalized);
                self.call_channel(
                    "manuscripts:create-file",
                    json!({
                        "parentPath": parent_path,
                        "name": name,
                        "title": args.string(&["title"]),
                        "content": payload_string(payload, "content")
                            .or_else(|| args.string(&["content"]))
                            .unwrap_or_default(),
                    }),
                )
            }
            "delete" => self.call_channel(
                "manuscripts:delete",
                json!(args
                    .string(&["path"])
                    .or_else(|| args.positionals.first().cloned())
                    .ok_or_else(|| "manuscripts delete requires --path".to_string())?),
            ),
            _ => Err(format!("unsupported manuscripts action: {action}")),
        }
    }

    fn handle_manuscript_theme(&self, tokens: &[String], payload: &Value) -> Result<Value, String> {
        let Some(action) = tokens.first().map(String::as_str) else {
            return Ok(help_response(Some("manuscripts")));
        };
        let args = parse_cli_args(&tokens[1..])?;
        let file_path = args
            .string(&["path", "file-path", "filePath"])
            .or_else(|| payload_string(payload, "path"))
            .or_else(|| payload_string(payload, "filePath"));
        match action {
            "apply" => self.call_channel(
                "manuscripts:set-richpost-theme",
                json!({
                    "filePath": file_path.ok_or_else(|| "manuscripts theme apply requires --path".to_string())?,
                    "themeId": args
                        .string(&["theme-id", "themeId"])
                        .or_else(|| payload_string(payload, "themeId"))
                        .ok_or_else(|| "manuscripts theme apply requires --theme-id".to_string())?,
                }),
            ),
            "preview" => {
                let mut merged = merge_payload(&args.options, payload);
                if let Some(object) = merged.as_object_mut() {
                    object.entry("filePath".to_string()).or_insert(json!(
                        file_path.ok_or_else(|| "manuscripts theme preview requires --path".to_string())?
                    ));
                }
                self.call_channel("manuscripts:preview-richpost-theme-draft", merged)
            }
            "create" => {
                let mut merged = merge_payload(&args.options, payload);
                if let Some(object) = merged.as_object_mut() {
                    object.entry("filePath".to_string()).or_insert(json!(
                        file_path.ok_or_else(|| "manuscripts theme create requires --path".to_string())?
                    ));
                }
                self.call_channel("manuscripts:create-richpost-custom-theme", merged)
            }
            "save" => {
                let mut merged = merge_payload(&args.options, payload);
                if let Some(object) = merged.as_object_mut() {
                    object.entry("filePath".to_string()).or_insert(json!(
                        file_path.ok_or_else(|| "manuscripts theme save requires --path".to_string())?
                    ));
                }
                self.call_channel("manuscripts:save-richpost-custom-theme", merged)
            }
            "delete" => self.call_channel(
                "manuscripts:delete-richpost-custom-theme",
                json!({
                    "filePath": file_path.ok_or_else(|| "manuscripts theme delete requires --path".to_string())?,
                    "themeId": args
                        .string(&["theme-id", "themeId"])
                        .or_else(|| payload_string(payload, "themeId"))
                        .ok_or_else(|| "manuscripts theme delete requires --theme-id".to_string())?,
                }),
            ),
            "background-upload" => self.call_channel(
                "manuscripts:upload-richpost-theme-background",
                json!({
                    "filePath": file_path.ok_or_else(|| "manuscripts theme background-upload requires --path".to_string())?,
                    "themeId": args
                        .string(&["theme-id", "themeId"])
                        .or_else(|| payload_string(payload, "themeId"))
                        .ok_or_else(|| "manuscripts theme background-upload requires --theme-id".to_string())?,
                    "role": args
                        .string(&["role"])
                        .or_else(|| payload_string(payload, "role")),
                }),
            ),
            "previews" => {
                let mut merged = merge_payload(&args.options, payload);
                if let Some(object) = merged.as_object_mut() {
                    object.entry("filePath".to_string()).or_insert(json!(
                        file_path.ok_or_else(|| "manuscripts theme previews requires --path".to_string())?
                    ));
                }
                self.call_channel("manuscripts:get-richpost-theme-previews", merged)
            }
            _ => Err(format!("unsupported manuscripts theme action: {action}")),
        }
    }

    fn handle_manuscript_layout(
        &self,
        tokens: &[String],
        payload: &Value,
    ) -> Result<Value, String> {
        let Some(action) = tokens.first().map(String::as_str) else {
            return Ok(help_response(Some("manuscripts")));
        };
        let args = parse_cli_args(&tokens[1..])?;
        match action {
            "get" => self.call_channel("manuscripts:get-layout", json!({})),
            "save" => self.call_channel("manuscripts:save-layout", payload.clone()),
            "preset" => self.call_channel(
                "manuscripts:set-longform-layout-preset",
                json!({
                    "filePath": args
                        .string(&["path", "file-path", "filePath"])
                        .or_else(|| payload_string(payload, "path"))
                        .or_else(|| payload_string(payload, "filePath"))
                        .ok_or_else(|| "manuscripts layout preset requires --path".to_string())?,
                    "presetId": args
                        .string(&["preset-id", "presetId"])
                        .or_else(|| payload_string(payload, "presetId"))
                        .ok_or_else(|| "manuscripts layout preset requires --preset-id".to_string())?,
                    "target": args.string(&["target"]).or_else(|| payload_string(payload, "target")),
                    "modelConfig": payload_field(payload, "modelConfig").cloned(),
                }),
            ),
            "render" => {
                let mut merged = merge_payload(&args.options, payload);
                if let Some(object) = merged.as_object_mut() {
                    let file_path = args
                        .string(&["path", "file-path", "filePath"])
                        .or_else(|| payload_string(payload, "path"))
                        .or_else(|| payload_string(payload, "filePath"))
                        .ok_or_else(|| "manuscripts layout render requires --path".to_string())?;
                    object.entry("filePath".to_string()).or_insert(json!(file_path));
                }
                self.call_channel("manuscripts:render-package-html", merged)
            }
            _ => Err(format!("unsupported manuscripts layout action: {action}")),
        }
    }

    fn handle_media(&self, tokens: &[String], payload: &Value) -> Result<Value, String> {
        let Some(action) = tokens.first().map(String::as_str) else {
            return Ok(help_response(Some("media")));
        };
        let args = parse_cli_args(&tokens[1..])?;
        match action {
            "list" => self.call_channel("media:list", json!({})),
            "get" => {
                let asset_id = args
                    .string(&["id", "asset-id"])
                    .or_else(|| args.positionals.first().cloned())
                    .ok_or_else(|| "media get requires --id".to_string())?;
                let result = self.call_channel("media:list", json!({}))?;
                let asset = result
                    .get("assets")
                    .and_then(Value::as_array)
                    .and_then(|items| {
                        items.iter().find(|item| {
                            item.get("id")
                                .and_then(Value::as_str)
                                .map(|value| value == asset_id)
                                .unwrap_or(false)
                        })
                    })
                    .cloned();
                Ok(json!({ "success": asset.is_some(), "asset": asset }))
            }
            "update" => self.call_channel("media:update", merge_payload(&args.options, payload)),
            "bind" => self.call_channel("media:bind", merge_payload(&args.options, payload)),
            "delete" => self.call_channel(
                "media:delete",
                json!({
                    "assetId": args
                        .string(&["asset-id", "id"])
                        .or_else(|| args.positionals.first().cloned())
                        .ok_or_else(|| "media delete requires --asset-id".to_string())?
                }),
            ),
            _ => Err(format!("unsupported media action: {action}")),
        }
    }

    fn handle_image(&self, tokens: &[String], payload: &Value) -> Result<Value, String> {
        let Some(action) = tokens.first().map(String::as_str) else {
            return Ok(help_response(Some("image")));
        };
        let args = parse_cli_args(&tokens[1..])?;
        match action {
            "generate" => self.handle_image_generate(&args, payload),
            "history" => {
                let sub = tokens.get(1).map(String::as_str).unwrap_or("list");
                match sub {
                    "list" => self.generated_media_history("image"),
                    "get" => {
                        let nested_args = parse_cli_args(&tokens[2..])?;
                        let id = nested_args
                            .string(&["id", "asset-id"])
                            .or_else(|| nested_args.positionals.first().cloned())
                            .ok_or_else(|| "image history get requires --id".to_string())?;
                        self.generated_media_history_get("image", &id)
                    }
                    _ => Err(format!("unsupported image history action: {sub}")),
                }
            }
            "providers" | "models" => {
                let summary = self.call_channel("db:get-settings", json!({}))?;
                Ok(json!({
                    "imageProvider": summary.get("image_provider").cloned().unwrap_or(Value::Null),
                    "imageProviderTemplate": summary.get("image_provider_template").cloned().unwrap_or(Value::Null),
                    "imageModel": summary.get("image_model").cloned().unwrap_or(Value::Null),
                    "imageEndpoint": summary.get("image_endpoint").cloned().unwrap_or(Value::Null),
                    "hasImageApiKey": summary
                        .get("image_api_key")
                        .and_then(Value::as_str)
                        .map(|value| !value.trim().is_empty())
                        .unwrap_or(false)
                }))
            }
            _ => Err(format!("unsupported image action: {action}")),
        }
    }

    fn handle_video(&self, tokens: &[String], payload: &Value) -> Result<Value, String> {
        let Some(action) = tokens.first().map(String::as_str) else {
            return Ok(help_response(Some("video")));
        };
        let args = parse_cli_args(&tokens[1..])?;
        match action {
            "generate" => self.handle_video_generate(&args, payload),
            "project-create" => self.handle_video_project_create(&args, payload),
            "project-list" => self.handle_video_project_list(),
            "project-get" => self.handle_video_project_get(&args),
            "project-brief" => self.handle_video_project_brief(&args, payload),
            "project-script" => self.handle_video_project_script(&args, payload),
            "project-asset-add" => self.handle_video_project_asset_add(&args, payload),
            _ => Err(format!("unsupported video action: {action}")),
        }
    }

    fn handle_knowledge(&self, tokens: &[String], payload: &Value) -> Result<Value, String> {
        let Some(action) = tokens.first().map(String::as_str) else {
            return Ok(help_response(Some("knowledge")));
        };
        let args = parse_cli_args(&tokens[1..])?;
        match action {
            "list" => Ok(json!({
                "notes": self.call_channel("knowledge:list", json!({}))?,
                "youtube": self.call_channel("knowledge:list-youtube", json!({}))?,
                "documentSources": self.call_channel("knowledge:docs:list", json!({}))?
            })),
            "search" => self.call_channel(
                "knowledge:list",
                json!({}),
            )
            .and_then(|_| {
                let query = args
                    .string(&["query", "q"])
                    .or_else(|| payload_string(payload, "query"))
                    .or_else(|| {
                        if args.positionals.is_empty() {
                            None
                        } else {
                            Some(args.positionals.join(" "))
                        }
                    })
                    .unwrap_or_default()
                    .to_lowercase();
                let limit = args
                    .i64(&["limit"])
                    .or_else(|| payload_field(payload, "limit").and_then(Value::as_i64))
                    .unwrap_or(8)
                    .clamp(1, 20) as usize;
                with_store(self.state, |store| {
                    let mut hits = Vec::<Value>::new();
                    for note in &store.knowledge_notes {
                        let haystack = format!(
                            "{}\n{}\n{}",
                            note.title,
                            note.content,
                            note.transcript.clone().unwrap_or_default()
                        )
                        .to_lowercase();
                        if haystack.contains(&query) {
                            hits.push(json!({
                                "kind": "note",
                                "id": note.id,
                                "title": note.title,
                                "snippet": text_snippet(&note.content, 220),
                                "sourceUrl": note.source_url,
                            }));
                        }
                    }
                    for video in &store.youtube_videos {
                        let haystack = format!(
                            "{}\n{}\n{}\n{}",
                            video.title,
                            video.description,
                            video.summary.clone().unwrap_or_default(),
                            video.subtitle_content.clone().unwrap_or_default()
                        )
                        .to_lowercase();
                        if haystack.contains(&query) {
                            hits.push(json!({
                                "kind": "youtube",
                                "id": video.id,
                                "title": video.title,
                                "snippet": text_snippet(
                                    &video.summary.clone().unwrap_or_else(|| video.description.clone()),
                                    220
                                ),
                                "videoUrl": video.video_url,
                            }));
                        }
                    }
                    Ok(json!({
                        "success": true,
                        "results": hits.into_iter().take(limit).collect::<Vec<_>>()
                    }))
                })
            }),
            _ => Err(format!("unsupported knowledge action: {action}")),
        }
    }

    fn handle_work(&self, tokens: &[String], payload: &Value) -> Result<Value, String> {
        let Some(action) = tokens.first().map(String::as_str) else {
            return Ok(help_response(Some("work")));
        };
        let args = parse_cli_args(&tokens[1..])?;
        match action {
            "list" => {
                let result = self.call_channel("work:list", json!({}))?;
                let mut items = result.as_array().cloned().unwrap_or_default();
                let status = args
                    .string(&["status"])
                    .or_else(|| payload_string(payload, "status"));
                if let Some(status) = status.filter(|value| !value.trim().is_empty()) {
                    items.retain(|item| {
                        item.get("status")
                            .and_then(Value::as_str)
                            .map(|value| value == status)
                            .unwrap_or(false)
                    });
                }
                let limit = args
                    .i64(&["limit"])
                    .or_else(|| payload_field(payload, "limit").and_then(Value::as_i64))
                    .unwrap_or(20)
                    .clamp(1, 50) as usize;
                items.truncate(limit);
                Ok(json!({ "success": true, "workItems": items }))
            }
            "ready" => self.call_channel("work:ready", json!({})),
            "get" => self.call_channel(
                "work:get",
                json!({
                    "id": args
                        .string(&["id"])
                        .or_else(|| args.positionals.first().cloned())
                        .ok_or_else(|| "work get requires --id".to_string())?
                }),
            ),
            "update" => self.call_channel("work:update", merge_payload(&args.options, payload)),
            _ => Err(format!("unsupported work action: {action}")),
        }
    }

    fn handle_memory(&self, tokens: &[String], payload: &Value) -> Result<Value, String> {
        let Some(action) = tokens.first().map(String::as_str) else {
            return Ok(help_response(Some("memory")));
        };
        let args = parse_cli_args(&tokens[1..])?;
        match action {
            "list" => self.call_channel("memory:list", json!({})),
            "search" => self.call_channel(
                "memory:search",
                json!({
                    "query": args
                        .string(&["query", "q"])
                        .or_else(|| payload_string(payload, "query"))
                        .or_else(|| {
                            if args.positionals.is_empty() {
                                None
                            } else {
                                Some(args.positionals.join(" "))
                            }
                        })
                        .unwrap_or_default()
                }),
            ),
            "add" => self.call_channel("memory:add", merge_payload(&args.options, payload)),
            "delete" => self.call_channel(
                "memory:delete",
                json!(args
                    .string(&["id"])
                    .or_else(|| args.positionals.first().cloned())
                    .ok_or_else(|| "memory delete requires --id".to_string())?),
            ),
            _ => Err(format!("unsupported memory action: {action}")),
        }
    }

    fn handle_redclaw(&self, tokens: &[String], payload: &Value) -> Result<Value, String> {
        let Some(action) = tokens.first().map(String::as_str) else {
            return Ok(help_response(Some("redclaw")));
        };
        let args = parse_cli_args(&tokens[1..])?;
        match action {
            "list-projects" | "projects" => {
                Ok(json!({ "success": true, "projects": [], "deprecated": true }))
            }
            "runner-status" => self.call_channel("redclaw:runner-status", json!({})),
            "runner-run-now" => self.call_channel("redclaw:runner-run-now", json!({})),
            "runner-start" => self.call_channel(
                "redclaw:runner-start",
                merge_payload(&args.options, payload),
            ),
            "runner-stop" => self.call_channel("redclaw:runner-stop", json!({})),
            "runner-set-config" => self.call_channel(
                "redclaw:runner-set-config",
                merge_payload(&args.options, payload),
            ),
            "profile-bundle" => self.call_channel("redclaw:profile:get-bundle", json!({})),
            "profile-read" => {
                let doc_type = args
                    .string(&["doc-type", "type"])
                    .or_else(|| args.positionals.first().cloned())
                    .unwrap_or_else(|| "user".to_string());
                let bundle = self.call_channel("redclaw:profile:get-bundle", json!({}))?;
                let content = match doc_type.as_str() {
                    "agent" => bundle
                        .pointer("/files/agent")
                        .cloned()
                        .unwrap_or(Value::Null),
                    "soul" => bundle
                        .pointer("/files/soul")
                        .cloned()
                        .unwrap_or(Value::Null),
                    "identity" => bundle
                        .pointer("/files/identity")
                        .cloned()
                        .unwrap_or(Value::Null),
                    "user" => bundle
                        .pointer("/files/user")
                        .cloned()
                        .unwrap_or(Value::Null),
                    "creator_profile" | "creator-profile" => bundle
                        .pointer("/files/creatorProfile")
                        .cloned()
                        .unwrap_or(Value::Null),
                    _ => Value::Null,
                };
                Ok(json!({
                    "success": !content.is_null(),
                    "docType": doc_type,
                    "content": content
                }))
            }
            "profile-update" => self.call_channel(
                "redclaw:profile:update-doc",
                json!({
                    "docType": args
                        .string(&["doc-type", "type"])
                        .or_else(|| args.positionals.first().cloned())
                        .ok_or_else(|| "redclaw profile-update requires --doc-type".to_string())?,
                    "markdown": payload_string(payload, "markdown")
                        .or_else(|| args.string(&["markdown"]))
                        .unwrap_or_default(),
                    "reason": args.string(&["reason"])
                }),
            ),
            "profile-onboarding" => {
                let bundle = self.call_channel("redclaw:profile:get-bundle", json!({}))?;
                let onboarding = bundle
                    .get("onboardingState")
                    .cloned()
                    .unwrap_or(Value::Null);
                Ok(json!({
                    "success": !onboarding.is_null(),
                    "completed": onboarding
                        .get("completedAt")
                        .and_then(Value::as_str)
                        .map(|value| !value.trim().is_empty())
                        .unwrap_or(false),
                    "state": onboarding
                }))
            }
            _ => Err(format!("unsupported redclaw action: {action}")),
        }
    }

    fn handle_runtime(&self, tokens: &[String], payload: &Value) -> Result<Value, String> {
        let Some(action) = tokens.first().map(String::as_str) else {
            return Ok(help_response(Some("runtime")));
        };
        let args = parse_cli_args(&tokens[1..])?;
        match action {
            "query" => self.call_channel(
                "runtime:query",
                json!({
                    "sessionId": args
                        .string(&["session-id", "sessionId"])
                        .or_else(|| payload_string(payload, "sessionId")),
                    "message": args
                        .string(&["message"])
                        .or_else(|| payload_string(payload, "message"))
                        .unwrap_or_default(),
                    "modelConfig": payload_field(payload, "modelConfig").cloned().unwrap_or(Value::Null),
                }),
            ),
            "resume" => self.call_channel(
                "runtime:resume",
                json!({
                    "sessionId": args
                        .string(&["session-id", "sessionId"])
                        .or_else(|| payload_string(payload, "sessionId"))
                        .unwrap_or_default()
                }),
            ),
            "fork-session" => self.call_channel(
                "runtime:fork-session",
                json!({
                    "sessionId": args
                        .string(&["session-id", "sessionId"])
                        .or_else(|| payload_string(payload, "sessionId"))
                        .unwrap_or_default()
                }),
            ),
            "get-trace" => self.call_channel(
                "runtime:get-trace",
                json!({
                    "sessionId": args
                        .string(&["session-id", "sessionId"])
                        .or_else(|| payload_string(payload, "sessionId"))
                        .unwrap_or_default(),
                    "limit": args
                        .i64(&["limit"])
                        .or_else(|| payload_field(payload, "limit").and_then(Value::as_i64))
                        .unwrap_or(50)
                }),
            ),
            "get-checkpoints" => self.call_channel(
                "runtime:get-checkpoints",
                json!({
                    "sessionId": args
                        .string(&["session-id", "sessionId"])
                        .or_else(|| payload_string(payload, "sessionId"))
                        .unwrap_or_default(),
                    "limit": args
                        .i64(&["limit"])
                        .or_else(|| payload_field(payload, "limit").and_then(Value::as_i64))
                        .unwrap_or(50)
                }),
            ),
            "get-tool-results" => self.call_channel(
                "runtime:get-tool-results",
                json!({
                    "sessionId": args
                        .string(&["session-id", "sessionId"])
                        .or_else(|| payload_string(payload, "sessionId"))
                        .unwrap_or_default(),
                    "limit": args
                        .i64(&["limit"])
                        .or_else(|| payload_field(payload, "limit").and_then(Value::as_i64))
                        .unwrap_or(50)
                }),
            ),
            "tasks" => {
                let sub = tokens.get(1).map(String::as_str).unwrap_or("list");
                let nested_args = parse_cli_args(&tokens[2..])?;
                match sub {
                    "create" => self.call_channel(
                        "tasks:create",
                        payload_field(payload, "payload")
                            .cloned()
                            .unwrap_or_else(|| merge_payload(&nested_args.options, payload)),
                    ),
                    "list" => self.call_channel("tasks:list", json!({})),
                    "get" => self.call_channel(
                        "tasks:get",
                        json!({
                            "taskId": nested_args
                                .string(&["task-id", "taskId"])
                                .or_else(|| payload_string(payload, "taskId"))
                                .ok_or_else(|| "runtime tasks get requires --task-id".to_string())?
                        }),
                    ),
                    "resume" => self.call_channel(
                        "tasks:resume",
                        json!({
                            "taskId": nested_args
                                .string(&["task-id", "taskId"])
                                .or_else(|| payload_string(payload, "taskId"))
                                .ok_or_else(|| "runtime tasks resume requires --task-id".to_string())?
                        }),
                    ),
                    "cancel" => self.call_channel(
                        "tasks:cancel",
                        json!({
                            "taskId": nested_args
                                .string(&["task-id", "taskId"])
                                .or_else(|| payload_string(payload, "taskId"))
                                .ok_or_else(|| "runtime tasks cancel requires --task-id".to_string())?
                        }),
                    ),
                    _ => Err(format!("unsupported runtime tasks action: {sub}")),
                }
            }
            "background" => {
                let sub = tokens.get(1).map(String::as_str).unwrap_or("list");
                let nested_args = parse_cli_args(&tokens[2..])?;
                match sub {
                    "list" => self.call_channel("background-tasks:list", json!({})),
                    "get" => self.call_channel(
                        "background-tasks:get",
                        json!({
                            "taskId": nested_args
                                .string(&["task-id", "taskId"])
                                .or_else(|| payload_string(payload, "taskId"))
                                .ok_or_else(|| "runtime background get requires --task-id".to_string())?
                        }),
                    ),
                    "cancel" => self.call_channel(
                        "background-tasks:cancel",
                        json!({
                            "taskId": nested_args
                                .string(&["task-id", "taskId"])
                                .or_else(|| payload_string(payload, "taskId"))
                                .ok_or_else(|| "runtime background cancel requires --task-id".to_string())?
                        }),
                    ),
                    _ => Err(format!("unsupported runtime background action: {sub}")),
                }
            }
            "session-enter-diagnostics" => self.call_channel(
                "chat:create-diagnostics-session",
                json!({
                    "title": args.string(&["title"]).or_else(|| payload_string(payload, "title")),
                    "contextId": args
                        .string(&["context-id", "contextId"])
                        .or_else(|| payload_string(payload, "contextId")),
                    "contextType": args
                        .string(&["context-type", "contextType"])
                        .or_else(|| payload_string(payload, "contextType")),
                }),
            ),
            "session-bridge" => {
                let sub = tokens.get(1).map(String::as_str).unwrap_or("status");
                let nested_args = parse_cli_args(&tokens[2..])?;
                match sub {
                    "status" => self.call_channel("session-bridge:status", json!({})),
                    "list-sessions" => self.call_channel("session-bridge:list-sessions", json!({})),
                    "get-session" => self.call_channel(
                        "session-bridge:get-session",
                        json!({
                            "sessionId": nested_args
                                .string(&["session-id", "sessionId"])
                                .or_else(|| payload_string(payload, "sessionId"))
                                .ok_or_else(|| "runtime session-bridge get-session requires --session-id".to_string())?
                        }),
                    ),
                    _ => Err(format!("unsupported runtime session-bridge action: {sub}")),
                }
            }
            _ => Err(format!("unsupported runtime action: {action}")),
        }
    }

    fn handle_settings(&self, tokens: &[String], payload: &Value) -> Result<Value, String> {
        let Some(action) = tokens.first().map(String::as_str) else {
            return Ok(help_response(Some("settings")));
        };
        match action {
            "summary" => self.call_channel("db:get-settings", json!({})).map(|value| {
                json!({
                    "defaultAiSourceId": value.get("default_ai_source_id").cloned().unwrap_or(Value::Null),
                    "modelName": value.get("model_name").cloned().unwrap_or(Value::Null),
                    "apiEndpoint": value.get("api_endpoint").cloned().unwrap_or(Value::Null),
                    "hasApiKey": value
                        .get("api_key")
                        .and_then(Value::as_str)
                        .map(|item| !item.trim().is_empty())
                        .unwrap_or(false),
                    "hasEmbeddingKey": value
                        .get("embedding_key")
                        .and_then(Value::as_str)
                        .map(|item| !item.trim().is_empty())
                        .unwrap_or(false),
                    "hasMcpConfig": value
                        .get("mcp_servers_json")
                        .and_then(Value::as_str)
                        .map(|item| item != "[]" && !item.trim().is_empty())
                        .unwrap_or(false)
                })
            }),
            "get" => self.call_channel("db:get-settings", json!({})),
            "set" => self.call_channel("db:save-settings", payload.clone()),
            _ => Err(format!("unsupported settings action: {action}")),
        }
    }

    fn handle_skills(&self, tokens: &[String], _payload: &Value) -> Result<Value, String> {
        let Some(action) = tokens.first().map(String::as_str) else {
            return Ok(help_response(Some("skills")));
        };
        let args = parse_cli_args(&tokens[1..])?;
        match action {
            "list" => self.call_channel("skills:list", json!({})),
            "invoke" => self.call_channel(
                "skills:invoke",
                json!({
                    "name": args
                        .string(&["name"])
                        .or_else(|| args.positionals.first().cloned())
                        .ok_or_else(|| "skills invoke requires --name".to_string())?,
                    "sessionId": self.session_id,
                    "runtimeMode": self.runtime_mode,
                }),
            ),
            "enable" => self.call_channel(
                "skills:enable",
                json!({
                    "name": args
                        .string(&["name"])
                        .or_else(|| args.positionals.first().cloned())
                        .ok_or_else(|| "skills enable requires --name".to_string())?
                }),
            ),
            "create" => self.call_channel(
                "skills:create",
                json!({
                    "name": args
                        .string(&["name"])
                        .or_else(|| args.positionals.first().cloned())
                        .ok_or_else(|| "skills create requires --name".to_string())?
                }),
            ),
            "save" => self.call_channel(
                "skills:save",
                json!({
                    "location": args
                        .string(&["location"])
                        .ok_or_else(|| "skills save requires --location".to_string())?,
                    "content": args
                        .string(&["content"])
                        .unwrap_or_default(),
                }),
            ),
            "disable" => self.call_channel(
                "skills:disable",
                json!({
                    "name": args
                        .string(&["name"])
                        .or_else(|| args.positionals.first().cloned())
                        .ok_or_else(|| "skills disable requires --name".to_string())?
                }),
            ),
            "market-install" => self.call_channel(
                "skills:market-install",
                json!({
                    "slug": args
                        .string(&["slug"])
                        .or_else(|| args.positionals.first().cloned())
                        .ok_or_else(|| "skills market-install requires --slug".to_string())?
                }),
            ),
            _ => Err(format!("unsupported skills action: {action}")),
        }
    }

    fn handle_mcp(&self, tokens: &[String], payload: &Value) -> Result<Value, String> {
        let Some(action) = tokens.first().map(String::as_str) else {
            return Ok(help_response(Some("mcp")));
        };
        let args = parse_cli_args(&tokens[1..])?;
        let server_value = payload_field(payload, "server")
            .cloned()
            .unwrap_or_else(|| json!({}));
        let parse_server = || -> Result<McpServerRecord, String> {
            serde_json::from_value(server_value.clone()).map_err(|error| error.to_string())
        };
        match action {
            "list" => commands::mcp_tools::mcp_list_value(self.state),
            "sessions" => commands::mcp_tools::mcp_sessions_value(self.state),
            "oauth-status" => commands::mcp_tools::mcp_oauth_status_value(
                self.state,
                &args
                    .string(&["id", "server-id"])
                    .or_else(|| args.positionals.first().cloned())
                    .ok_or_else(|| "mcp oauth-status requires --id".to_string())?,
            ),
            "save" => commands::mcp_tools::mcp_save_value(self.state, payload),
            "test" => commands::mcp_tools::mcp_probe_value(self.state, &parse_server()?),
            "call" => commands::mcp_tools::mcp_call_value(
                self.state,
                &parse_server()?,
                &args
                    .string(&["method"])
                    .or_else(|| payload_string(payload, "method"))
                    .unwrap_or_default(),
                payload_field(payload, "params")
                    .cloned()
                    .unwrap_or_else(|| json!({})),
                args.string(&["session-id", "sessionId"])
                    .or_else(|| payload_string(payload, "sessionId")),
            ),
            "list-tools" => commands::mcp_tools::mcp_call_value(
                self.state,
                &parse_server()?,
                "tools/list",
                json!({}),
                args.string(&["session-id", "sessionId"])
                    .or_else(|| payload_string(payload, "sessionId")),
            ),
            "list-resources" => commands::mcp_tools::mcp_call_value(
                self.state,
                &parse_server()?,
                "resources/list",
                json!({}),
                args.string(&["session-id", "sessionId"])
                    .or_else(|| payload_string(payload, "sessionId")),
            ),
            "list-resource-templates" => commands::mcp_tools::mcp_call_value(
                self.state,
                &parse_server()?,
                "resources/templates/list",
                json!({}),
                args.string(&["session-id", "sessionId"])
                    .or_else(|| payload_string(payload, "sessionId")),
            ),
            "disconnect" => commands::mcp_tools::mcp_disconnect_value(self.state, &parse_server()?),
            "disconnect-all" => commands::mcp_tools::mcp_disconnect_all_value(self.state),
            "discover-local" => commands::mcp_tools::mcp_discover_local_value(),
            "import-local" => commands::mcp_tools::mcp_import_local_value(self.state),
            _ => Err(format!("unsupported mcp action: {action}")),
        }
    }

    fn handle_ai(&self, tokens: &[String], payload: &Value) -> Result<Value, String> {
        let Some(action) = tokens.first().map(String::as_str) else {
            return Ok(help_response(Some("ai")));
        };
        let args = parse_cli_args(&tokens[1..])?;
        match action {
            "roles-list" => self.call_channel("ai:roles:list", json!({})),
            "detect-protocol" => self.call_channel(
                "ai:detect-protocol",
                json!({
                    "baseURL": args
                        .string(&["base-url", "baseURL"])
                        .or_else(|| payload_string(payload, "baseURL"))
                        .unwrap_or_default(),
                    "presetId": args
                        .string(&["preset-id", "presetId"])
                        .or_else(|| payload_string(payload, "presetId")),
                    "protocol": args
                        .string(&["protocol"])
                        .or_else(|| payload_string(payload, "protocol")),
                }),
            ),
            "test-connection" => self.call_channel(
                "ai:test-connection",
                json!({
                    "baseURL": args
                        .string(&["base-url", "baseURL"])
                        .or_else(|| payload_string(payload, "baseURL"))
                        .unwrap_or_default(),
                    "apiKey": args
                        .string(&["api-key", "apiKey"])
                        .or_else(|| payload_string(payload, "apiKey")),
                    "presetId": args
                        .string(&["preset-id", "presetId"])
                        .or_else(|| payload_string(payload, "presetId")),
                    "protocol": args
                        .string(&["protocol"])
                        .or_else(|| payload_string(payload, "protocol")),
                }),
            ),
            "fetch-models" => self.call_channel(
                "ai:fetch-models",
                json!({
                    "baseURL": args
                        .string(&["base-url", "baseURL"])
                        .or_else(|| payload_string(payload, "baseURL"))
                        .unwrap_or_default(),
                    "apiKey": args
                        .string(&["api-key", "apiKey"])
                        .or_else(|| payload_string(payload, "apiKey")),
                    "presetId": args
                        .string(&["preset-id", "presetId"])
                        .or_else(|| payload_string(payload, "presetId")),
                    "protocol": args
                        .string(&["protocol"])
                        .or_else(|| payload_string(payload, "protocol")),
                }),
            ),
            _ => Err(format!("unsupported ai action: {action}")),
        }
    }

    fn handle_video_project_create(
        &self,
        args: &CliArgs,
        payload: &Value,
    ) -> Result<Value, String> {
        if !video_project_create_requested_explicitly(args, payload) {
            return Err(
                "video project-create requires explicit project workflow confirmation. \
For one-off generation, use `video generate` and keep the output in media/. \
Only create a `.redvideo` project when the user explicitly asks for a project/package/editor workflow. \
Pass `--explicit-project-workflow true` or `payload.explicitProjectWorkflow=true` after explicit confirmation."
                    .to_string(),
            );
        }
        let title = args
            .string(&["title"])
            .or_else(|| args.positionals.first().cloned())
            .unwrap_or_else(|| "Untitled Video".to_string());
        let relative = build_video_project_relative_path(args.string(&["path"]));
        let (parent_path, name) = split_parent_and_name(&relative);
        let script_content = payload_string(payload, "content")
            .or_else(|| payload_string(payload, "script"))
            .or_else(|| args.string(&["content", "script", "brief"]))
            .unwrap_or_default();
        self.call_channel(
            "manuscripts:create-file",
            json!({
                "parentPath": parent_path,
                "name": name,
                "title": title.clone(),
                "content": script_content.clone()
            }),
        )?;
        self.call_channel(
            "manuscripts:save",
            json!({
                "path": relative,
                "content": script_content,
                "metadata": {
                    "title": title,
                    "aspectRatio": args.string(&["aspect-ratio", "aspectRatio"]),
                    "duration": args.string(&["duration"]),
                    "mode": args.string(&["mode"]),
                    "draftType": "video",
                    "packageKind": "video"
                }
            }),
        )?;
        let state = self.call_channel(
            "manuscripts:get-video-project-state",
            json!({ "filePath": relative.clone() }),
        )?;
        Ok(json!({
            "success": true,
            "path": relative,
            "videoProjectId": video_project_stem_from_path(&relative),
            "project": state
        }))
    }

    fn handle_video_project_list(&self) -> Result<Value, String> {
        let tree = self.call_channel("manuscripts:list", json!({}))?;
        let mut projects = Vec::<Value>::new();
        collect_video_projects(&tree, &mut projects);
        Ok(json!({ "success": true, "projects": projects }))
    }

    fn handle_video_project_get(&self, args: &CliArgs) -> Result<Value, String> {
        let file_path = self.resolve_video_project_path(
            args.string(&["path", "id", "video-project-id", "videoProjectId"])
                .or_else(|| args.positionals.first().cloned())
                .ok_or_else(|| "video project-get requires --path".to_string())?,
        )?;
        self.call_channel(
            "manuscripts:get-video-project-state",
            json!({
                "filePath": file_path
            }),
        )
    }

    fn handle_video_project_brief(&self, args: &CliArgs, payload: &Value) -> Result<Value, String> {
        let path = self.resolve_video_project_path(
            args.string(&["path", "id", "video-project-id", "videoProjectId"])
                .or_else(|| payload_string(payload, "path"))
                .or_else(|| payload_string(payload, "id"))
                .or_else(|| payload_string(payload, "videoProjectPath"))
                .or_else(|| payload_string(payload, "videoProjectId"))
                .or_else(|| args.positionals.first().cloned())
                .ok_or_else(|| "video project-brief requires --path".to_string())?,
        )?;
        if let Some(content) = payload_string(payload, "content")
            .or_else(|| payload_string(payload, "brief"))
            .or_else(|| args.string(&["content", "brief"]))
        {
            let video_project_id = video_project_stem_from_path(&path);
            let saved = self.call_channel(
                "manuscripts:save-video-project-brief",
                json!({
                    "filePath": path.clone(),
                    "content": content,
                    "source": "user"
                }),
            )?;
            return Ok(json!({
                "success": saved.get("success").and_then(Value::as_bool).unwrap_or(true),
                "path": path,
                "videoProjectId": video_project_id,
                "brief": saved.get("brief").cloned().unwrap_or(Value::Null),
                "project": saved.get("project").cloned().unwrap_or(Value::Null),
                "state": saved.get("state").cloned().unwrap_or(Value::Null)
            }));
        }
        let project = self.call_channel(
            "manuscripts:get-video-project-state",
            json!({ "filePath": path.clone() }),
        )?;
        let project_state = project.get("project").cloned().unwrap_or(Value::Null);
        let video_project_id = video_project_stem_from_path(&path);
        Ok(json!({
            "success": project.get("success").and_then(Value::as_bool).unwrap_or(true),
            "path": path,
            "videoProjectId": video_project_id,
            "brief": project_state.get("brief").cloned().unwrap_or(Value::Null),
            "project": project_state.clone(),
            "videoProject": project_state.clone(),
            "script": project_state.get("scriptBody").cloned().unwrap_or(Value::Null),
            "scriptApproval": project_state.get("scriptApproval").cloned().unwrap_or(Value::Null),
            "assets": project_state.get("assets").cloned().unwrap_or_else(|| json!([])),
            "renderOutput": project_state.get("renderOutput").cloned().unwrap_or(Value::Null)
        }))
    }

    fn handle_video_project_script(
        &self,
        args: &CliArgs,
        payload: &Value,
    ) -> Result<Value, String> {
        let path = self.resolve_video_project_path(
            args.string(&["path", "id", "video-project-id", "videoProjectId"])
                .or_else(|| payload_string(payload, "path"))
                .or_else(|| payload_string(payload, "id"))
                .or_else(|| args.positionals.first().cloned())
                .ok_or_else(|| "video project-script requires --path".to_string())?,
        )?;
        if let Some(content) =
            payload_string(payload, "content").or_else(|| args.string(&["content"]))
        {
            return self.call_channel(
                "manuscripts:save",
                json!({
                    "path": path,
                    "content": content,
                    "metadata": payload_field(payload, "metadata").cloned().unwrap_or_else(|| json!({}))
                }),
            );
        }
        self.call_channel("manuscripts:read", json!(path))
    }

    fn handle_video_project_asset_add(
        &self,
        args: &CliArgs,
        payload: &Value,
    ) -> Result<Value, String> {
        let asset_id = args
            .string(&["asset-id", "assetId"])
            .or_else(|| payload_string(payload, "assetId"))
            .or_else(|| args.positionals.get(1).cloned());
        if let Some(asset_id) = asset_id.filter(|value| !value.trim().is_empty()) {
            let file_path = self.resolve_video_project_path(
                args.string(&["path", "id", "video-project-id", "videoProjectId"])
                    .or_else(|| payload_string(payload, "path"))
                    .or_else(|| payload_string(payload, "id"))
                    .or_else(|| payload_string(payload, "videoProjectPath"))
                    .or_else(|| payload_string(payload, "videoProjectId"))
                    .or_else(|| args.positionals.first().cloned())
                    .ok_or_else(|| "video project-asset-add requires --path".to_string())?,
            )?;
            return self.call_channel(
                "manuscripts:add-package-clip",
                json!({
                    "filePath": file_path,
                    "assetId": asset_id,
                    "track": args.string(&["track"]),
                    "order": args.i64(&["order"]),
                    "durationMs": args.i64(&["duration-ms", "durationMs"])
                }),
            );
        }

        let project_locator = args
            .string(&["id", "video-project-id", "videoProjectId"])
            .or_else(|| payload_string(payload, "id"))
            .or_else(|| payload_string(payload, "videoProjectId"))
            .or_else(|| payload_string(payload, "projectId"))
            .or_else(|| payload_string(payload, "videoProjectPath"))
            .or_else(|| {
                args.string(&["path"]).and_then(|value| {
                    if value.ends_with(VIDEO_DRAFT_EXTENSION)
                        || (!std::path::Path::new(&value).is_absolute() && value.contains('/'))
                    {
                        Some(value)
                    } else {
                        None
                    }
                })
            })
            .or_else(|| args.positionals.first().cloned())
            .ok_or_else(|| {
                "video project-asset-add requires a project locator (--id or --path)".to_string()
            })?;
        let file_path = self.resolve_video_project_path(project_locator)?;
        let source_path = args
            .string(&["source", "source-path", "sourcePath"])
            .or_else(|| payload_string(payload, "sourcePath"))
            .or_else(|| {
                args.string(&["path"]).and_then(|value| {
                    if std::path::Path::new(&value).is_absolute() {
                        Some(value)
                    } else {
                        None
                    }
                })
            })
            .or_else(|| args.positionals.get(1).cloned())
            .ok_or_else(|| {
                "video project-asset-add requires --source-path when --asset-id is absent"
                    .to_string()
            })?;
        self.call_channel(
            "manuscripts:attach-package-file",
            json!({
                "filePath": file_path,
                "sourcePath": source_path,
                "kind": args.string(&["kind"]).or_else(|| payload_string(payload, "kind")),
                "label": args.string(&["label"]).or_else(|| payload_string(payload, "label")),
                "role": args.string(&["role"]).or_else(|| payload_string(payload, "role"))
            }),
        )
    }

    fn handle_image_generate(&self, args: &CliArgs, payload: &Value) -> Result<Value, String> {
        let mut merged = build_generation_payload(args, payload);
        let subject_matches = self.collect_subject_matches(args, payload, 4)?;
        let subject_reference_images = subject_matches
            .iter()
            .flat_map(|subject| value_string_list(subject.get("absoluteImagePaths"), 4))
            .take(4)
            .collect::<Vec<_>>();
        let mut reference_images = value_string_list(merged.get("referenceImages"), 4);
        reference_images.extend(subject_reference_images);
        dedupe_string_list(&mut reference_images, 4);
        if let Some(object) = merged.as_object_mut() {
            if !reference_images.is_empty() {
                object.insert("referenceImages".to_string(), json!(reference_images));
                if object
                    .get("generationMode")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .trim()
                    .is_empty()
                {
                    object.insert("generationMode".to_string(), json!("reference-guided"));
                }
            }
        }
        self.run_preflight_image_skill_activation();
        self.call_channel("image-gen:generate", merged)
    }

    fn run_preflight_image_skill_activation(&self) {
        let Some(session_id) = self.session_id else {
            return;
        };
        let item = with_store(self.state, |store| {
            Ok(preflight_skill_activation_item(
                &store.skills,
                self.runtime_mode,
                IMAGE_PROMPT_OPTIMIZER_SKILL_NAME,
            ))
        })
        .ok()
        .flatten();
        let Some((name, description)) = item else {
            return;
        };
        let call_id = make_id("tool-call");
        let command = format!("skills invoke --name {name}");
        emit_runtime_tool_request(
            self.app,
            Some(session_id),
            &call_id,
            "app_cli",
            json!({
                "command": command,
            }),
            Some("Preflight skill activation before image generation"),
        );
        let invoke_result = self.call_channel(
            "skills:invoke",
            json!({
                "name": name,
                "sessionId": session_id,
                "runtimeMode": self.runtime_mode,
            }),
        );
        match invoke_result {
            Ok(result) => {
                let output =
                    serde_json::to_string_pretty(&result).unwrap_or_else(|_| result.to_string());
                emit_runtime_tool_result(
                    self.app,
                    Some(session_id),
                    &call_id,
                    "app_cli",
                    true,
                    &output,
                );
            }
            Err(error) => {
                emit_runtime_tool_result(
                    self.app,
                    Some(session_id),
                    &call_id,
                    "app_cli",
                    false,
                    &error,
                );
                return;
            }
        }
        emit_runtime_task_checkpoint_saved(
            self.app,
            None,
            Some(session_id),
            "chat.skill_activated",
            "skill activated",
            Some(json!({
                "name": name,
                "description": description,
                "runtimeMode": self.runtime_mode,
                "activationSource": "host.image-generate-preflight",
            })),
        );
    }

    fn emit_tool_partial(&self, content: &str) {
        let Some(tool_call_id) = self.tool_call_id else {
            return;
        };
        let trimmed = content.trim();
        if trimmed.is_empty() {
            return;
        }
        emit_runtime_tool_partial(self.app, self.session_id, tool_call_id, "app_cli", trimmed);
    }

    fn handle_video_generate(&self, args: &CliArgs, payload: &Value) -> Result<Value, String> {
        let mut merged = build_generation_payload(args, payload);
        let video_project_path = self
            .video_project_locator_from_generate(args, payload)
            .map(|locator| self.resolve_video_project_path(locator))
            .transpose()?;
        let video_project_state = video_project_path
            .as_ref()
            .map(|project_path| {
                self.call_channel(
                    "manuscripts:get-video-project-state",
                    json!({ "filePath": project_path }),
                )
            })
            .transpose()?;
        let subject_matches = self.collect_subject_matches(args, payload, 5)?;
        let subject_reference_images = subject_matches
            .iter()
            .flat_map(|subject| value_string_list(subject.get("absoluteImagePaths"), 1))
            .take(5)
            .collect::<Vec<_>>();
        let mut reference_images = value_string_list(merged.get("referenceImages"), 5);
        let project_reference_images = video_project_state
            .as_ref()
            .map(|state| extract_video_project_reference_images(state, 5))
            .unwrap_or_default();
        if reference_images.is_empty() && !project_reference_images.is_empty() {
            reference_images.extend(project_reference_images);
        }
        reference_images.extend(subject_reference_images);
        dedupe_string_list(&mut reference_images, 5);
        let explicit_driving_audio = args
            .string(&["driving-audio", "audio-url"])
            .or_else(|| payload_string(payload, "drivingAudio"))
            .filter(|item| !item.trim().is_empty());
        let inferred_driving_audio = explicit_driving_audio.clone().or_else(|| {
            subject_matches.iter().find_map(|subject| {
                subject
                    .get("absoluteVoicePath")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|item| !item.is_empty())
                    .map(ToString::to_string)
            })
        });
        if let Some(object) = merged.as_object_mut() {
            if !reference_images.is_empty() {
                object.insert("referenceImages".to_string(), json!(reference_images));
                if object
                    .get("generationMode")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .trim()
                    .is_empty()
                {
                    object.insert("generationMode".to_string(), json!("reference-guided"));
                }
            }
            if let Some(driving_audio) = inferred_driving_audio {
                object.insert("drivingAudio".to_string(), json!(driving_audio));
            }
            if let Some(project_path) = video_project_path.clone() {
                object.insert("videoProjectPath".to_string(), json!(project_path));
            }
            if let Some(session_id) = self.session_id {
                object.insert("sessionId".to_string(), json!(session_id));
            }
            if let Some(tool_call_id) = self.tool_call_id {
                object.insert("toolCallId".to_string(), json!(tool_call_id));
                object.insert("toolName".to_string(), json!("app_cli"));
            }
        }
        if let Some(compiled_prompt) =
            compile_video_generation_prompt(&merged, video_project_state.as_ref())
        {
            if let Some(object) = merged.as_object_mut() {
                object.insert("prompt".to_string(), json!(compiled_prompt));
            }
        }
        self.emit_tool_partial("视频生成已提交到宿主，正在准备 provider 请求。");
        let result = self.call_channel("video-gen:generate", merged)?;
        if let Some(project_path) = video_project_path {
            if let Some(assets) = result.get("assets").and_then(Value::as_array) {
                for asset in assets {
                    let Some(asset_id) = asset.get("id").and_then(Value::as_str) else {
                        continue;
                    };
                    self.call_channel(
                        "manuscripts:add-package-clip",
                        json!({
                            "filePath": project_path,
                            "assetId": asset_id
                        }),
                    )?;
                }
            }
            let project_state = self.call_channel(
                "manuscripts:get-video-project-state",
                json!({ "filePath": project_path.clone() }),
            )?;
            return Ok(merge_video_generation_result(
                result,
                Some(project_path),
                Some(project_state),
            ));
        }
        Ok(merge_video_generation_result(result, None, None))
    }

    fn video_project_locator_from_generate(
        &self,
        args: &CliArgs,
        payload: &Value,
    ) -> Option<String> {
        args.string(&["path", "video-project-path", "videoProjectPath"])
            .or_else(|| payload_string(payload, "videoProjectPath"))
            .or_else(|| payload_string(payload, "path"))
            .or_else(|| {
                args.string(&[
                    "video-project-id",
                    "videoProjectId",
                    "project-id",
                    "projectId",
                ])
            })
            .or_else(|| payload_string(payload, "videoProjectId"))
            .or_else(|| payload_string(payload, "projectId"))
            .filter(|value| !value.trim().is_empty())
    }

    fn resolve_video_project_path(&self, locator: String) -> Result<String, String> {
        let trimmed = locator.trim();
        if trimmed.is_empty() {
            return Err("video project locator is empty".to_string());
        }
        let normalized = normalize_relative_path(trimmed);
        if normalized.contains('/') || normalized.ends_with(VIDEO_DRAFT_EXTENSION) {
            return Ok(ensure_manuscript_file_name(
                &normalized,
                VIDEO_DRAFT_EXTENSION,
            ));
        }
        let default_path =
            ensure_manuscript_file_name(&format!("video/{normalized}"), VIDEO_DRAFT_EXTENSION);
        let tree = self.call_channel("manuscripts:list", json!({}))?;
        let mut projects = Vec::<Value>::new();
        collect_video_projects(&tree, &mut projects);
        let target_file_name = format!("{normalized}{VIDEO_DRAFT_EXTENSION}");
        let matches = projects
            .iter()
            .filter_map(|item| item.get("path").and_then(Value::as_str))
            .map(str::trim)
            .filter(|path| !path.is_empty())
            .filter(|path| {
                *path == default_path
                    || *path == target_file_name
                    || path.ends_with(&format!("/{target_file_name}"))
            })
            .map(ToString::to_string)
            .collect::<Vec<_>>();
        if matches.len() == 1 {
            Ok(matches[0].clone())
        } else {
            Ok(default_path)
        }
    }

    fn collect_subject_matches(
        &self,
        args: &CliArgs,
        payload: &Value,
        limit: usize,
    ) -> Result<Vec<Value>, String> {
        let subject_ids = comma_list_strings(
            args.value(&["subject-ids", "subjectIds"])
                .or_else(|| payload_field(payload, "subjectIds").cloned()),
        );
        if !subject_ids.is_empty() {
            let mut matches = Vec::<Value>::new();
            for id in subject_ids.into_iter().take(limit) {
                let result = self.call_channel("subjects:get", json!({ "id": id }))?;
                if let Some(subject) = result
                    .get("subject")
                    .cloned()
                    .filter(|item| !item.is_null())
                {
                    matches.push(subject);
                }
            }
            return Ok(matches);
        }
        let subject_query = args
            .string(&["subject-query", "query-subjects"])
            .or_else(|| payload_string(payload, "subjectQuery"));
        if let Some(subject_query) = subject_query.filter(|item| !item.trim().is_empty()) {
            let result = self.call_channel("subjects:search", json!({ "query": subject_query }))?;
            return Ok(result
                .get("subjects")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .take(limit)
                .collect());
        }
        Ok(Vec::new())
    }

    fn generated_media_history(&self, kind: &str) -> Result<Value, String> {
        let result = self.call_channel("media:list", json!({}))?;
        let assets = result
            .get("assets")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter(|item| media_matches_kind(item, kind))
            .collect::<Vec<_>>();
        Ok(json!({ "success": true, "assets": assets }))
    }

    fn generated_media_history_get(&self, kind: &str, id: &str) -> Result<Value, String> {
        let result = self.generated_media_history(kind)?;
        let asset = result
            .get("assets")
            .and_then(Value::as_array)
            .and_then(|items| {
                items.iter().find(|item| {
                    item.get("id")
                        .and_then(Value::as_str)
                        .map(|value| value == id)
                        .unwrap_or(false)
                })
            })
            .cloned();
        Ok(json!({ "success": asset.is_some(), "asset": asset }))
    }

    fn call_channel(&self, channel: &str, payload: Value) -> Result<Value, String> {
        if let Some(result) =
            commands::system::handle_system_channel(self.app, self.state, channel, &payload)
        {
            return result;
        }
        if let Some(result) =
            commands::spaces::handle_spaces_channel(self.app, self.state, channel, &payload)
        {
            return result;
        }
        if let Some(result) =
            commands::subjects::handle_subjects_channel(self.app, self.state, channel, &payload)
        {
            return result;
        }
        if let Some(result) =
            commands::advisor_ops::handle_advisor_channel(self.app, self.state, channel, &payload)
        {
            return result;
        }
        if let Some(result) =
            commands::library::handle_library_channel(self.app, self.state, channel, &payload)
        {
            return result;
        }
        if let Some(result) =
            commands::generation::handle_generation_channel(self.app, self.state, channel, &payload)
        {
            return result;
        }
        if let Some(result) = commands::workspace_data::handle_workspace_data_channel(
            self.app, self.state, channel, &payload,
        ) {
            return result;
        }
        if let Some(result) = commands::manuscripts::handle_manuscripts_channel(
            self.app, self.state, channel, &payload,
        ) {
            return result;
        }
        if let Some(result) =
            commands::redclaw::handle_redclaw_channel(self.app, self.state, channel, &payload)
        {
            return result;
        }
        if let Some(result) =
            commands::skills_ai::handle_skills_ai_channel(self.app, self.state, channel, &payload)
        {
            return result;
        }
        if let Some(result) =
            commands::mcp_tools::handle_mcp_tools_channel(self.app, self.state, channel, &payload)
        {
            return result;
        }
        if let Some(result) =
            commands::runtime::handle_runtime_channel(self.app, self.state, channel, &payload)
        {
            return result;
        }
        if let Some(result) =
            commands::bridge::handle_bridge_channel(self.app, self.state, channel, &payload)
        {
            return result;
        }
        if let Some(result) = commands::chat_sessions_wander::handle_chat_sessions_wander_channel(
            self.app, self.state, channel, &payload,
        ) {
            return result;
        }
        Err(format!("app_cli channel not handled: {channel}"))
    }

    fn bound_writing_session_target(&self) -> Option<BoundWritingSessionTarget> {
        let session_id = self.session_id?;
        with_store(self.state, |store| {
            let metadata = store
                .chat_sessions
                .iter()
                .find(|item| item.id == session_id)
                .and_then(|session| session.metadata.as_ref());
            let Some(metadata) = metadata else {
                return Ok(None);
            };
            let file_path = payload_string(metadata, "associatedPackageFilePath")
                .or_else(|| payload_string(metadata, "associatedFilePath"))
                .unwrap_or_default();
            let draft_type = payload_string(metadata, "associatedPackageKind")
                .or_else(|| payload_string(metadata, "draftType"))
                .unwrap_or_else(|| get_draft_type_from_file_name(&file_path).to_string());
            if file_path.trim().is_empty()
                || !matches!(draft_type.as_str(), "longform" | "richpost")
            {
                return Ok(None);
            }
            Ok(Some(BoundWritingSessionTarget {
                file_path,
                draft_type,
                title: payload_string(metadata, "associatedPackageTitle"),
            }))
        })
        .ok()
        .flatten()
    }

    fn current_authoring_target_preference(&self) -> Option<AuthoringTargetPreference> {
        if let Some(target) = self.bound_writing_session_target() {
            let draft_type = target.draft_type.to_ascii_lowercase();
            let preferred_extension = match draft_type.as_str() {
                "longform" => ARTICLE_DRAFT_EXTENSION,
                "richpost" => POST_DRAFT_EXTENSION,
                _ => return None,
            };
            return Some(AuthoringTargetPreference {
                preferred_extension,
            });
        }

        let session_id = self.session_id?;
        with_store(self.state, |store| {
            let metadata = store
                .chat_sessions
                .iter()
                .find(|item| item.id == session_id)
                .and_then(|session| session.metadata.as_ref());
            let Some(metadata) = metadata else {
                return Ok(None);
            };
            let intent = payload_string(metadata, "intent")
                .or_else(|| {
                    metadata
                        .get("taskHints")
                        .and_then(|value| payload_string(value, "intent"))
                })
                .unwrap_or_default();
            if intent != "manuscript_creation" {
                return Ok(None);
            }
            let platform = payload_string(metadata, "platform").or_else(|| {
                metadata
                    .get("taskHints")
                    .and_then(|value| payload_string(value, "platform"))
            });
            let preference = match platform.as_deref() {
                Some("wechat_official_account") => AuthoringTargetPreference {
                    preferred_extension: ARTICLE_DRAFT_EXTENSION,
                },
                Some("xiaohongshu") => AuthoringTargetPreference {
                    preferred_extension: POST_DRAFT_EXTENSION,
                },
                _ => AuthoringTargetPreference {
                    preferred_extension: POST_DRAFT_EXTENSION,
                },
            };
            Ok(Some(preference))
        })
        .ok()
        .flatten()
    }

    fn normalize_manuscript_target_path(&self, requested_path: &str) -> String {
        let normalized = normalize_relative_path(requested_path);
        if normalized.trim().is_empty() {
            return normalized;
        }
        let Some(preference) = self.current_authoring_target_preference() else {
            return ensure_manuscript_file_name(&normalized, ".md");
        };
        let resolved = resolve_manuscript_path(self.state, &normalized).ok();
        let target_exists = resolved.as_ref().map(|path| path.exists()).unwrap_or(false);
        if normalized.ends_with(preference.preferred_extension) {
            return normalized;
        }
        if normalized.ends_with(ARTICLE_DRAFT_EXTENSION)
            || normalized.ends_with(POST_DRAFT_EXTENSION)
            || normalized.ends_with(VIDEO_DRAFT_EXTENSION)
            || normalized.ends_with(AUDIO_DRAFT_EXTENSION)
        {
            return normalized;
        }
        if normalized.ends_with(".md") {
            if target_exists {
                return normalized;
            }
            let stem = normalized.trim_end_matches(".md");
            return format!("{stem}{}", preference.preferred_extension);
        }
        if target_exists {
            return normalized;
        }
        ensure_manuscript_file_name(&normalized, preference.preferred_extension)
    }

    fn maybe_queue_writing_manuscript_proposal(
        &self,
        target_path: &str,
        content: String,
        metadata: Option<&Value>,
    ) -> Result<Option<Value>, String> {
        let Some(target) = self.bound_writing_session_target() else {
            return Ok(None);
        };
        let normalized_target_path = normalize_relative_path(target_path);
        if normalize_relative_path(&target.file_path) != normalized_target_path {
            return Ok(None);
        }
        let current =
            self.call_channel("manuscripts:read", json!(normalized_target_path.clone()))?;
        let current_content = payload_string(&current, "content").unwrap_or_default();
        let frontmatter_block = extract_markdown_frontmatter_block(&current_content);
        let proposed_body = strip_markdown_frontmatter(&content);
        let proposed_content =
            compose_markdown_with_frontmatter(&proposed_body, frontmatter_block.as_deref());
        if proposed_content == current_content {
            return Ok(Some(json!({
                "success": true,
                "proposalCreated": false,
                "unchanged": true,
                "filePath": normalized_target_path,
                "message": "AI 返回的稿件与当前内容一致，没有生成新的改稿提案。"
            })));
        }
        let timestamp = now_iso();
        let proposal = crate::ManuscriptWriteProposalRecord {
            id: make_id("manuscript-proposal"),
            file_path: normalized_target_path.clone(),
            session_id: self.session_id.map(ToString::to_string),
            tool_call_id: self.tool_call_id.map(ToString::to_string),
            draft_type: Some(target.draft_type),
            title: target.title,
            metadata: metadata.cloned(),
            base_content: current_content,
            proposed_content,
            created_at: timestamp.clone(),
            updated_at: timestamp,
        };
        let saved = commands::manuscripts::upsert_manuscript_write_proposal(
            self.app, self.state, proposal,
        )?;
        Ok(Some(json!({
            "success": true,
            "proposalCreated": true,
            "requiresReview": true,
            "filePath": saved.file_path,
            "proposal": saved,
            "message": "已生成待审改稿提案。请在稿件编辑器里查看 diff，并手动接受或拒绝。"
        })))
    }
}

fn parse_cli_args(tokens: &[String]) -> Result<CliArgs, String> {
    let mut args = CliArgs::default();
    let mut index = 0usize;
    while index < tokens.len() {
        let token = &tokens[index];
        if let Some(stripped) = token.strip_prefix("--") {
            if stripped.is_empty() {
                return Err("invalid empty option".to_string());
            }
            if let Some((key, value)) = stripped.split_once('=') {
                args.options
                    .insert(key.to_string(), parse_option_value(value));
                index += 1;
                continue;
            }
            let next = tokens.get(index + 1);
            if let Some(value) = next.filter(|item| !item.starts_with("--")) {
                args.options
                    .insert(stripped.to_string(), parse_option_value(value));
                index += 2;
                continue;
            }
            args.options.insert(stripped.to_string(), Value::Bool(true));
            index += 1;
            continue;
        }
        args.positionals.push(token.clone());
        index += 1;
    }
    Ok(args)
}

fn tokenize_command(input: &str) -> Vec<String> {
    let mut tokens = Vec::<String>::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut chars = input.trim().chars().peekable();
    while let Some(ch) = chars.next() {
        if let Some(active_quote) = quote {
            match ch {
                '\\' => {
                    if let Some(next) = chars.next() {
                        if next == active_quote || next == '\\' {
                            current.push(next);
                        } else {
                            current.push(ch);
                            current.push(next);
                        }
                    } else {
                        current.push(ch);
                    }
                }
                value if value == active_quote => quote = None,
                value => current.push(value),
            }
            continue;
        }

        match ch {
            '"' | '\'' => quote = Some(ch),
            value if value.is_whitespace() => {
                if !current.is_empty() {
                    tokens.push(std::mem::take(&mut current));
                }
            }
            '\\' => {
                if let Some(next) = chars.next() {
                    current.push(next);
                } else {
                    current.push(ch);
                }
            }
            value => current.push(value),
        }
    }

    if !current.is_empty() {
        tokens.push(current);
    }
    tokens
}

fn preflight_skill_activation_item(
    skills: &[SkillRecord],
    runtime_mode: &str,
    skill_name: &str,
) -> Option<(String, String)> {
    let skill = find_catalog_skill_by_name(skills, skill_name)?;
    if skill.disabled || !skill_allows_runtime_mode(&skill, runtime_mode) {
        return None;
    }
    Some((skill.name, skill.description))
}

fn parse_option_value(raw: &str) -> Value {
    let trimmed = raw.trim();
    match trimmed.to_ascii_lowercase().as_str() {
        "true" => Value::Bool(true),
        "false" => Value::Bool(false),
        _ => {
            if let Ok(value) = trimmed.parse::<i64>() {
                return json!(value);
            }
            if let Ok(value) = trimmed.parse::<f64>() {
                if value.is_finite() {
                    return json!(value);
                }
            }
            Value::String(trimmed.to_string())
        }
    }
}

fn merge_payload(options: &Map<String, Value>, payload: &Value) -> Value {
    let mut merged = options.clone();
    if let Some(payload_object) = payload.as_object() {
        for (key, value) in payload_object {
            merged.insert(key.clone(), value.clone());
        }
    }
    Value::Object(merged)
}

fn build_generation_payload(args: &CliArgs, payload: &Value) -> Value {
    let mut merged = payload
        .as_object()
        .cloned()
        .unwrap_or_else(Map::<String, Value>::new);
    let prompt = args.string(&["prompt"]).or_else(|| {
        if args.positionals.is_empty() {
            None
        } else {
            Some(args.positionals.join(" "))
        }
    });
    copy_optional_string(&mut merged, "prompt", prompt);
    copy_optional_string(&mut merged, "title", args.string(&["title"]));
    copy_optional_string(&mut merged, "provider", args.string(&["provider"]));
    copy_optional_string(
        &mut merged,
        "providerTemplate",
        args.string(&["provider-template", "providerTemplate"]),
    );
    copy_optional_string(&mut merged, "model", args.string(&["model"]));
    copy_optional_string(
        &mut merged,
        "aspectRatio",
        args.string(&["aspect-ratio", "aspectRatio"]),
    );
    copy_optional_string(&mut merged, "size", args.string(&["size"]));
    copy_optional_string(&mut merged, "quality", args.string(&["quality"]));
    copy_optional_string(
        &mut merged,
        "projectId",
        args.string(&[
            "project-id",
            "projectId",
            "video-project-id",
            "videoProjectId",
        ]),
    );
    copy_optional_string(
        &mut merged,
        "generationMode",
        args.string(&["generation-mode", "generationMode", "mode"]),
    );
    copy_optional_string(
        &mut merged,
        "resolution",
        args.string(&["resolution", "size"]),
    );
    copy_optional_string(
        &mut merged,
        "drivingAudio",
        args.string(&["driving-audio", "audio-url", "drivingAudio"]),
    );
    copy_optional_string(
        &mut merged,
        "firstClip",
        args.string(&["first-clip", "video-url", "firstClip"]),
    );
    copy_optional_string(
        &mut merged,
        "subjectQuery",
        args.string(&["subject-query", "query-subjects", "subjectQuery"]),
    );
    if let Some(count) = args.i64(&["count"]) {
        merged.insert("count".to_string(), json!(count));
    }
    if let Some(duration_seconds) = args.i64(&["duration", "seconds", "durationSeconds"]) {
        merged.insert("durationSeconds".to_string(), json!(duration_seconds));
    }
    if let Some(generate_audio) = args.bool(&["audio", "generate-audio", "generateAudio"]) {
        merged.insert("generateAudio".to_string(), json!(generate_audio));
    }
    if let Some(subject_ids) = comma_list_value(args.value(&["subject-ids", "subjectIds"])) {
        merged.insert("subjectIds".to_string(), subject_ids);
    }
    if let Some(reference_images) =
        comma_list_value(args.value(&["reference-images", "referenceImages"]))
    {
        merged.insert("referenceImages".to_string(), reference_images);
    }
    if !merged.contains_key("generationMode") {
        if let Some(mode) = payload_string(payload, "mode").filter(|item| !item.trim().is_empty()) {
            merged.insert("generationMode".to_string(), json!(mode));
        }
    }
    if !merged.contains_key("aspectRatio") {
        if let Some(ratio) = payload_string(payload, "ratio").filter(|item| !item.trim().is_empty())
        {
            merged.insert("aspectRatio".to_string(), json!(ratio));
        }
    }
    if !merged.contains_key("durationSeconds") {
        let duration_seconds = payload_field(payload, "duration")
            .and_then(|value| match value {
                Value::Number(number) => number.as_i64(),
                Value::String(text) => text.trim().parse::<i64>().ok(),
                _ => None,
            })
            .or_else(|| {
                payload_field(payload, "seconds").and_then(|value| match value {
                    Value::Number(number) => number.as_i64(),
                    Value::String(text) => text.trim().parse::<i64>().ok(),
                    _ => None,
                })
            });
        if let Some(duration_seconds) = duration_seconds {
            merged.insert("durationSeconds".to_string(), json!(duration_seconds));
        }
    }
    if !merged.contains_key("projectId") {
        if let Some(value) = merged
            .get("videoProjectId")
            .cloned()
            .or_else(|| merged.get("video-project-id").cloned())
        {
            merged.insert("projectId".to_string(), value);
        }
    }
    Value::Object(merged)
}

fn comma_list_value(value: Option<Value>) -> Option<Value> {
    match value {
        Some(Value::Array(items)) => Some(Value::Array(items)),
        Some(Value::String(text)) => {
            let items = text
                .split(',')
                .map(str::trim)
                .filter(|item| !item.is_empty())
                .map(|item| json!(item))
                .collect::<Vec<_>>();
            Some(json!(items))
        }
        _ => None,
    }
}

fn comma_list_strings(value: Option<Value>) -> Vec<String> {
    match value {
        Some(Value::Array(items)) => items
            .into_iter()
            .filter_map(|item| item.as_str().map(str::trim).map(ToString::to_string))
            .filter(|item| !item.is_empty())
            .collect(),
        Some(Value::String(text)) => text
            .split(',')
            .map(str::trim)
            .filter(|item| !item.is_empty())
            .map(ToString::to_string)
            .collect(),
        _ => Vec::new(),
    }
}

fn value_string_list(value: Option<&Value>, limit: usize) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|item| !item.is_empty())
                .take(limit)
                .map(ToString::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

fn dedupe_string_list(items: &mut Vec<String>, limit: usize) {
    let mut deduped = Vec::<String>::new();
    for item in items.drain(..) {
        if !deduped.contains(&item) {
            deduped.push(item);
        }
        if deduped.len() >= limit {
            break;
        }
    }
    *items = deduped;
}

fn compact_whitespace(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn normalize_storyboard_cell(text: &str) -> String {
    compact_whitespace(
        &text
            .replace("<br />", " / ")
            .replace("<br/>", " / ")
            .replace("<br>", " / "),
    )
    .trim()
    .trim_matches('`')
    .to_string()
}

fn storyboard_header_kind(header: &str) -> Option<&'static str> {
    let normalized = header.trim().to_ascii_lowercase();
    if normalized.contains("time") || header.contains("时间") {
        return Some("time");
    }
    if normalized.contains("picture") || normalized.contains("visual") || header.contains("画面")
    {
        return Some("picture");
    }
    if normalized.contains("sound") || normalized.contains("audio") || header.contains("声音") {
        return Some("sound");
    }
    if normalized.contains("shot")
        || normalized.contains("camera")
        || header.contains("景别")
        || header.contains("镜头")
    {
        return Some("shot");
    }
    None
}

fn markdown_separator_row(cells: &[String]) -> bool {
    !cells.is_empty()
        && cells.iter().all(|cell| {
            let trimmed = cell.trim();
            !trimmed.is_empty()
                && trimmed
                    .chars()
                    .all(|ch| ch == '-' || ch == ':' || ch == ' ' || ch == '|' || ch == '\t')
        })
}

fn shot_from_storyboard_map(values: &Map<String, Value>) -> Option<VideoStoryboardShot> {
    let get = |keys: &[&str]| {
        keys.iter()
            .find_map(|key| values.get(*key))
            .and_then(Value::as_str)
            .map(normalize_storyboard_cell)
            .filter(|value| !value.is_empty())
    };
    let shot = VideoStoryboardShot {
        time: get(&["time", "Time", "时间"])?,
        picture: get(&["picture", "Picture", "visual", "Visual", "画面"])?,
        sound: get(&["sound", "Sound", "audio", "Audio", "声音"])
            .unwrap_or_else(|| "未指定".to_string()),
        shot: get(&["shot", "Shot", "camera", "Camera", "景别", "镜头"])
            .unwrap_or_else(|| "未指定".to_string()),
    };
    Some(shot)
}

fn extract_storyboard_shots_from_value(value: &Value) -> Vec<VideoStoryboardShot> {
    match value {
        Value::Array(items) => items
            .iter()
            .filter_map(|item| item.as_object().and_then(shot_from_storyboard_map))
            .collect(),
        Value::String(text) => parse_storyboard_markdown(text),
        Value::Object(values) => shot_from_storyboard_map(values).into_iter().collect(),
        _ => Vec::new(),
    }
}

fn parse_storyboard_markdown(markdown: &str) -> Vec<VideoStoryboardShot> {
    let mut header_kinds = Vec::<&'static str>::new();
    let mut shots = Vec::<VideoStoryboardShot>::new();

    for line in markdown.lines() {
        let trimmed = line.trim();
        if !trimmed.starts_with('|') || !trimmed.ends_with('|') {
            continue;
        }
        let cells = trimmed
            .trim_matches('|')
            .split('|')
            .map(normalize_storyboard_cell)
            .collect::<Vec<_>>();
        if cells.is_empty() {
            continue;
        }
        if header_kinds.is_empty() {
            let mapped = cells
                .iter()
                .filter_map(|cell| storyboard_header_kind(cell))
                .collect::<Vec<_>>();
            if mapped.len() == cells.len()
                && mapped.iter().any(|kind| *kind == "time")
                && mapped.iter().any(|kind| *kind == "picture")
            {
                header_kinds = mapped;
            }
            continue;
        }
        if markdown_separator_row(&cells) {
            continue;
        }
        if cells.len() < header_kinds.len() {
            continue;
        }
        let mut shot = VideoStoryboardShot::default();
        for (index, kind) in header_kinds.iter().enumerate() {
            let value = cells.get(index).cloned().unwrap_or_default();
            match *kind {
                "time" => shot.time = value,
                "picture" => shot.picture = value,
                "sound" => shot.sound = value,
                "shot" => shot.shot = value,
                _ => {}
            }
        }
        if shot.time.is_empty() || shot.picture.is_empty() {
            continue;
        }
        if shot.sound.is_empty() {
            shot.sound = "未指定".to_string();
        }
        if shot.shot.is_empty() {
            shot.shot = "未指定".to_string();
        }
        shots.push(shot);
    }

    shots
}

fn confirmed_project_storyboard(project_state: &Value) -> Vec<VideoStoryboardShot> {
    let status = project_state
        .pointer("/project/scriptApproval/status")
        .or_else(|| project_state.pointer("/scriptApproval/status"))
        .and_then(Value::as_str)
        .unwrap_or("pending");
    if status != "confirmed" {
        return Vec::new();
    }
    let script_body = project_state
        .pointer("/project/scriptBody")
        .or_else(|| project_state.get("scriptBody"))
        .and_then(Value::as_str)
        .unwrap_or("");
    parse_storyboard_markdown(script_body)
}

fn extract_video_storyboard(
    payload: &Value,
    project_state: Option<&Value>,
) -> Vec<VideoStoryboardShot> {
    for key in [
        "storyboardShots",
        "storyboard",
        "storyboardMarkdown",
        "approvedScript",
        "scriptMarkdown",
        "script",
    ] {
        let shots = payload_field(payload, key)
            .map(extract_storyboard_shots_from_value)
            .unwrap_or_default();
        if !shots.is_empty() {
            return shots;
        }
    }
    if let Some(state) = project_state {
        let shots = confirmed_project_storyboard(state);
        if !shots.is_empty() {
            return shots;
        }
    }
    payload_string(payload, "prompt")
        .map(|prompt| parse_storyboard_markdown(&prompt))
        .unwrap_or_default()
}

fn default_reference_image_label(generation_mode: &str, index: usize) -> String {
    match generation_mode {
        "first-last-frame" if index == 0 => "first-frame visual reference".to_string(),
        "first-last-frame" if index == 1 => "last-frame visual reference".to_string(),
        "continuation" if index == 0 => "previous clip continuation reference".to_string(),
        _ => "reference-guided visual anchor".to_string(),
    }
}

fn compile_video_generation_prompt(
    payload: &Value,
    project_state: Option<&Value>,
) -> Option<String> {
    let storyboard = extract_video_storyboard(payload, project_state);
    if storyboard.is_empty() {
        return None;
    }

    let base_prompt = payload_string(payload, "prompt")
        .map(|value| value.trim().to_string())
        .unwrap_or_default();
    let generation_mode =
        payload_string(payload, "generationMode").unwrap_or_else(|| "text-to-video".to_string());
    let aspect_ratio = payload_string(payload, "aspectRatio").unwrap_or_else(|| "16:9".to_string());
    let duration_seconds = payload_field(payload, "durationSeconds")
        .and_then(Value::as_i64)
        .unwrap_or(8);
    let reference_images = value_string_list(payload_field(payload, "referenceImages"), 5);
    let reference_image_labels =
        value_string_list(payload_field(payload, "referenceImageLabels"), 5);
    let driving_audio = payload_string(payload, "drivingAudio");
    let driving_audio_label = payload_string(payload, "drivingAudioLabel").unwrap_or_else(|| {
        "driving audio reference for tone, speaking rhythm, and beat timing".to_string()
    });
    let first_clip = payload_string(payload, "firstClip");

    let mut sections = Vec::<String>::new();

    let mut asset_lines = reference_images
        .iter()
        .enumerate()
        .map(|(index, _)| {
            let label = reference_image_labels
                .get(index)
                .cloned()
                .unwrap_or_else(|| default_reference_image_label(&generation_mode, index));
            format!("Image {}: {}", index + 1, label)
        })
        .collect::<Vec<_>>();
    if let Some(first_clip) = first_clip.filter(|value| !value.trim().is_empty()) {
        let label = payload_string(payload, "firstClipLabel")
            .unwrap_or_else(|| "existing clip reference for motion continuation".to_string());
        if !first_clip.is_empty() {
            asset_lines.push(format!("Clip 1: {label}"));
        }
    }
    if driving_audio.is_some() {
        asset_lines.push(format!("Audio 1: {driving_audio_label}"));
    }
    if !asset_lines.is_empty() {
        sections.push(asset_lines.join("\n"));
    }

    if !base_prompt.is_empty() && parse_storyboard_markdown(&base_prompt).is_empty() {
        sections.push(format!(
            "Creative brief: {}",
            compact_whitespace(&base_prompt)
        ));
    }

    sections.push(format!(
        "Execution spec: single video, {} seconds, aspect ratio {}, mode {}.",
        duration_seconds, aspect_ratio, generation_mode
    ));

    let storyboard_lines = storyboard
        .iter()
        .enumerate()
        .map(|(index, shot)| {
            format!(
                "Beat {} ({}): Picture: {}; Sound: {}; Shot: {}.",
                index + 1,
                shot.time,
                shot.picture,
                shot.sound,
                shot.shot
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    sections.push(format!("Approved storyboard beats:\n{storyboard_lines}"));

    let mut execution_rules = vec![
        "Follow the beat order exactly; do not collapse the storyboard into one generic summary."
            .to_string(),
        "Preserve the same main character identity, product shape, and prop continuity across all beats."
            .to_string(),
        format!(
            "Keep framing, camera movement, and action progression aligned with the approved {} storyboard.",
            aspect_ratio
        ),
    ];
    if generation_mode == "reference-guided" {
        execution_rules.push(
            "Use the reference images as stable visual anchors for identity, product details, and scene continuity."
                .to_string(),
        );
    }
    if generation_mode == "first-last-frame" {
        execution_rules.push(
            "Respect the first-frame and last-frame references as the fixed endpoints of the motion."
                .to_string(),
        );
    }
    if generation_mode == "continuation" {
        execution_rules.push(
            "Continue naturally from the reference clip instead of resetting the scene or character pose."
                .to_string(),
        );
    }
    if driving_audio.is_some() {
        execution_rules
            .push("Align body rhythm, lip-sync feel, and timing accents with Audio 1.".to_string());
    }
    sections.push(format!(
        "Execution requirements:\n- {}",
        execution_rules.join("\n- ")
    ));

    Some(sections.join("\n\n"))
}

fn copy_optional_string(target: &mut Map<String, Value>, key: &str, value: Option<String>) {
    if let Some(value) = value.filter(|item| !item.trim().is_empty()) {
        target.insert(key.to_string(), json!(value));
    }
}

fn split_parent_and_name(path: &str) -> (String, String) {
    match path.rsplit_once('/') {
        Some((parent, name)) => (parent.to_string(), name.to_string()),
        None => (String::new(), path.to_string()),
    }
}

fn payload_bool_value(value: &Value) -> Option<bool> {
    match value {
        Value::Bool(value) => Some(*value),
        Value::Number(value) => Some(value.as_i64().unwrap_or_default() != 0),
        Value::String(text) => match text.trim().to_ascii_lowercase().as_str() {
            "true" | "1" | "yes" | "on" => Some(true),
            "false" | "0" | "no" | "off" => Some(false),
            _ => None,
        },
        _ => None,
    }
}

fn payload_bool(payload: &Value, keys: &[&str]) -> Option<bool> {
    keys.iter()
        .find_map(|key| payload_field(payload, key).and_then(payload_bool_value))
}

fn video_project_create_requested_explicitly(args: &CliArgs, payload: &Value) -> bool {
    args.bool(&[
        "explicit-project-workflow",
        "explicitProjectWorkflow",
        "confirm-project-workflow",
        "confirmProjectWorkflow",
        "allow-project-create",
        "allowProjectCreate",
    ])
    .or_else(|| {
        payload_bool(
            payload,
            &[
                "explicitProjectWorkflow",
                "confirmProjectWorkflow",
                "allowProjectCreate",
            ],
        )
    })
    .unwrap_or(false)
}

fn now_timestamp_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn build_video_project_relative_path(explicit_path: Option<String>) -> String {
    let parent = explicit_path
        .map(|value| normalize_relative_path(&value))
        .map(|normalized| {
            if normalized.ends_with(VIDEO_DRAFT_EXTENSION) {
                split_parent_and_name(&normalized).0
            } else {
                normalized
            }
        })
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "video".to_string());
    ensure_manuscript_file_name(
        &format!("{parent}/{}", now_timestamp_millis()),
        VIDEO_DRAFT_EXTENSION,
    )
}

fn video_project_stem_from_path(path: &str) -> String {
    let normalized = normalize_relative_path(path);
    normalized
        .rsplit('/')
        .next()
        .unwrap_or(normalized.as_str())
        .trim_end_matches(VIDEO_DRAFT_EXTENSION)
        .to_string()
}

fn asset_looks_like_image(asset: &Value) -> bool {
    let mime = asset
        .get("mimeType")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("")
        .to_ascii_lowercase();
    if mime.starts_with("image/") {
        return true;
    }
    [
        "absolutePath",
        "mediaPath",
        "relativePath",
        "src",
        "previewUrl",
    ]
    .into_iter()
    .filter_map(|key| asset.get(key).and_then(Value::as_str))
    .map(str::trim)
    .any(|value| {
        let lower = value.to_ascii_lowercase();
        lower.ends_with(".png")
            || lower.ends_with(".jpg")
            || lower.ends_with(".jpeg")
            || lower.ends_with(".webp")
            || lower.ends_with(".gif")
            || lower.ends_with(".bmp")
            || lower.ends_with(".svg")
    })
}

fn extract_video_project_reference_images(project_state: &Value, limit: usize) -> Vec<String> {
    project_state
        .pointer("/project/assets")
        .or_else(|| project_state.get("assets"))
        .and_then(Value::as_array)
        .map(|assets| {
            assets
                .iter()
                .filter(|asset| asset_looks_like_image(asset))
                .filter_map(|asset| {
                    ["absolutePath", "mediaPath", "relativePath", "src"]
                        .into_iter()
                        .filter_map(|key| asset.get(key).and_then(Value::as_str))
                        .map(str::trim)
                        .find(|value| !value.is_empty())
                        .map(ToString::to_string)
                })
                .take(limit)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

fn merge_video_generation_result(
    mut result: Value,
    video_project_path: Option<String>,
    video_project: Option<Value>,
) -> Value {
    let Some(object) = result.as_object_mut() else {
        return result;
    };
    object.insert("kind".to_string(), json!("generated-videos"));
    if let Some(path) = video_project_path {
        object.insert("videoProjectPath".to_string(), json!(path));
        object.insert(
            "videoProjectId".to_string(),
            json!(video_project_stem_from_path(
                object
                    .get("videoProjectPath")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
            )),
        );
    }
    if let Some(project) = video_project {
        object.insert("videoProject".to_string(), project);
    }
    result
}

fn collect_video_projects(node: &Value, projects: &mut Vec<Value>) {
    let is_directory = node
        .get("isDirectory")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if !is_directory {
        let path = node
            .get("path")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let draft_type = node
            .get("draftType")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        if path.ends_with(VIDEO_DRAFT_EXTENSION) || draft_type == "video" {
            projects.push(json!({
                "path": path,
                "name": node.get("name").cloned().unwrap_or(Value::Null),
                "title": node.get("title").cloned().unwrap_or(Value::Null),
                "updatedAt": node.get("updatedAt").cloned().unwrap_or(Value::Null)
            }));
        }
    }
    if let Some(children) = node.get("children").and_then(Value::as_array) {
        for child in children {
            collect_video_projects(child, projects);
        }
    }
}

fn media_matches_kind(item: &Value, kind: &str) -> bool {
    let mime_type = item
        .get("mimeType")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_ascii_lowercase();
    match kind {
        "image" => mime_type.starts_with("image/"),
        "video" => mime_type.starts_with("video/") || mime_type == "text/markdown",
        _ => false,
    }
}

fn help_response(namespace: Option<&str>) -> Value {
    let namespace = namespace.unwrap_or("root");
    let commands = match namespace {
        "root" => vec![
            "help [namespace]",
            "advisors list|get|list-templates|create|update|delete",
            "chat sessions list|get",
            "spaces list|get|create|rename|switch",
            "subjects list|get|search|categories list|create|update|delete",
            "manuscripts list|read|write|create|delete|theme apply|preview|create|save|delete|background-upload|previews|layout get|save|preset|render",
            "media list|get|update|bind|delete",
            "image generate|history list|get|providers|models",
            "video generate|project-create|project-list|project-get|project-brief|project-script|project-asset-add",
            "knowledge list|search",
            "work list|ready|get|update",
            "memory list|search|add|delete",
            "redclaw runner-status|runner-run-now|runner-start|runner-stop|runner-set-config|profile-bundle|profile-read|profile-update|profile-onboarding",
            "runtime query|resume|fork-session|get-trace|get-checkpoints|get-tool-results|tasks create|list|get|resume|cancel|background list|get|cancel|session-enter-diagnostics|session-bridge status|list-sessions|get-session",
            "settings summary|get|set",
            "skills list|invoke|create|save|enable|disable|market-install",
            "mcp list|sessions|oauth-status|save|test|call|list-tools|list-resources|list-resource-templates|disconnect|disconnect-all|discover-local|import-local",
            "ai roles-list|detect-protocol|test-connection|fetch-models",
        ],
        "advisors" => vec![
            "advisors list",
            "advisors get --id <advisorId>",
            "advisors list-templates",
            "advisors create [payload]",
            "advisors update --id <advisorId> [payload]",
            "advisors delete --id <advisorId>",
        ],
        "chat" => vec!["chat sessions list", "chat sessions get --id <sessionId>"],
        "spaces" => vec![
            "spaces list",
            "spaces get --id <spaceId>",
            "spaces create --name <name>",
            "spaces rename --id <spaceId> --name <newName>",
            "spaces switch --id <spaceId>",
        ],
        "subjects" => vec![
            "subjects list",
            "subjects get --id <subjectId>",
            "subjects search --query \"keyword\"",
            "subjects categories list",
            "subjects categories create --name <name>",
            "subjects categories update --id <categoryId> --name <name>",
            "subjects categories delete --id <categoryId>",
        ],
        "manuscripts" => vec![
            "manuscripts list",
            "manuscripts read --path <relativePath>",
            "manuscripts write --path <relativePath> [payload.content]",
            "manuscripts create --path <relativePath>",
            "manuscripts delete --path <relativePath>",
            "manuscripts theme apply --path <relativePath> --theme-id <themeId>",
            "manuscripts theme preview --path <relativePath> [payload.theme]",
            "manuscripts theme create --path <relativePath> [payload.theme]",
            "manuscripts theme save --path <relativePath> [payload.theme]",
            "manuscripts theme delete --path <relativePath> --theme-id <themeId>",
            "manuscripts theme background-upload --path <relativePath> --theme-id <themeId> [--role body]",
            "manuscripts theme previews --path <relativePath> [payload.themeIds]",
            "manuscripts layout get",
            "manuscripts layout save [payload]",
            "manuscripts layout preset --path <relativePath> --preset-id <presetId>",
            "manuscripts layout render --path <relativePath> [--target layout]",
        ],
        "media" => vec![
            "media list",
            "media get --id <assetId>",
            "media update --asset-id <assetId> [--title ...]",
            "media bind --asset-id <assetId> --manuscript-path <path>",
            "media delete --asset-id <assetId>",
        ],
        "image" => vec![
            "skills invoke --name image-prompt-optimizer  # before the first image generate in chat-driven workflows",
            "image generate --prompt \"...\" [--mode reference-guided] [--reference-images /abs/a.png,/abs/b.png]",
            "image generate --prompt \"...\" [--subject-ids subject_a,subject_b]",
            "image history list",
            "image history get --id <assetId>",
            "image providers",
            "image models",
        ],
        "video" => vec![
            "video generate --prompt \"...\" [--mode text-to-video] [--duration 8] [--resolution 1080p]",
            "video generate --prompt \"...\" --mode reference-guided --reference-images /abs/a.png,/abs/b.png",
            "video generate --prompt \"...\" --mode first-last-frame --reference-images /abs/first.png,/abs/last.png",
            "video generate --prompt \"...\" --mode continuation --first-clip /abs/clip.mp4",
            "video generate --mode reference-guided --duration 6 --aspect-ratio 9:16  # put approved storyboardMarkdown/storyboardShots in payload so the host can compile the final execution prompt",
            "video project-create --explicit-project-workflow true --title \"...\" [--duration 8s] [--aspect-ratio 9:16]",
            "video project-list",
            "video project-get --path <relativePath>  # or --id <timestampStem>",
            "video project-brief --path <relativePath>  # or --id <timestampStem> [payload.content|payload.brief]",
            "video project-script --path <relativePath> [payload.content]",
            "video project-asset-add --path <relativePath> --asset-id <assetId>",
            "video project-asset-add --id <timestampStem> --path /abs/ref.png --kind reference-image",
            "video generate --mode reference-guided --duration 8 --aspect-ratio 9:16 --video-project-id <timestampStem>  # long prompt/reference data should go in payload; confirmed project scripts are used as storyboard input",
        ],
        "knowledge" => vec!["knowledge list", "knowledge search --query \"keyword\""],
        "work" => vec![
            "work list",
            "work ready",
            "work get --id <workId>",
            "work update --id <workId> [--status done]",
        ],
        "memory" => vec![
            "memory list",
            "memory search --query \"keyword\"",
            "memory add [payload.content / payload.tags]",
            "memory delete --id <memoryId>",
        ],
        "redclaw" => vec![
            "redclaw runner-status",
            "redclaw runner-run-now",
            "redclaw runner-start [--interval-minutes 15]",
            "redclaw runner-stop",
            "redclaw runner-set-config [payload]",
            "redclaw profile-bundle",
            "redclaw profile-read --doc-type user",
            "redclaw profile-update --doc-type user [payload.markdown]",
            "redclaw profile-onboarding",
        ],
        "runtime" => vec![
            "runtime query [--session-id <sessionId>] --message \"...\"",
            "runtime resume --session-id <sessionId>",
            "runtime fork-session --session-id <sessionId>",
            "runtime get-trace --session-id <sessionId> [--limit 50]",
            "runtime get-checkpoints --session-id <sessionId> [--limit 50]",
            "runtime get-tool-results --session-id <sessionId> [--limit 50]",
            "runtime tasks create [payload or payload.payload]",
            "runtime tasks list",
            "runtime tasks get --task-id <taskId>",
            "runtime tasks resume --task-id <taskId>",
            "runtime tasks cancel --task-id <taskId>",
            "runtime background list",
            "runtime background get --task-id <taskId>",
            "runtime background cancel --task-id <taskId>",
            "runtime session-enter-diagnostics [--title <title>]",
            "runtime session-bridge status",
            "runtime session-bridge list-sessions",
            "runtime session-bridge get-session --session-id <sessionId>",
        ],
        "settings" => vec!["settings summary", "settings get", "settings set [payload]"],
        "skills" => vec![
            "skills list",
            "skills invoke --name <skill>",
            "skills create --name <skill>",
            "skills save --location <path> --content \"...\"",
            "skills enable --name <skill>",
            "skills disable --name <skill>",
            "skills market-install --slug <slug>",
        ],
        "mcp" => vec![
            "mcp list",
            "mcp sessions",
            "mcp oauth-status --id <serverId>",
            "mcp save [payload]",
            "mcp test [payload.server]",
            "mcp call --method <method> [payload.server] [payload.params]",
            "mcp list-tools [payload.server]",
            "mcp list-resources [payload.server]",
            "mcp list-resource-templates [payload.server]",
            "mcp disconnect [payload.server]",
            "mcp disconnect-all",
            "mcp discover-local",
            "mcp import-local",
        ],
        "ai" => vec![
            "ai roles-list",
            "ai detect-protocol --base-url <url>",
            "ai test-connection --base-url <url> [--api-key <key>]",
            "ai fetch-models --base-url <url> [--api-key <key>]",
        ],
        _ => vec!["help"],
    };
    json!({
        "success": true,
        "namespace": namespace,
        "commands": commands,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_skill(name: &str, allowed_runtime_modes: &str, disabled: Option<bool>) -> SkillRecord {
        SkillRecord {
            name: name.to_string(),
            description: format!("{name} desc"),
            location: format!("redbox://skills/{name}"),
            body: format!(
                "---\nallowedRuntimeModes: [{allowed_runtime_modes}]\n---\n# {name}\n\nBody"
            ),
            source_scope: Some("builtin".to_string()),
            is_builtin: Some(true),
            disabled,
        }
    }

    #[test]
    fn preflight_skill_activation_item_requires_runtime_compatibility() {
        let skills = vec![test_skill(
            IMAGE_PROMPT_OPTIMIZER_SKILL_NAME,
            "chatroom, redclaw, image-generation",
            Some(false),
        )];

        let item =
            preflight_skill_activation_item(&skills, "redclaw", IMAGE_PROMPT_OPTIMIZER_SKILL_NAME);

        assert_eq!(
            item,
            Some((
                IMAGE_PROMPT_OPTIMIZER_SKILL_NAME.to_string(),
                "image-prompt-optimizer desc".to_string(),
            ))
        );
        assert_eq!(
            preflight_skill_activation_item(&skills, "wander", IMAGE_PROMPT_OPTIMIZER_SKILL_NAME,),
            None
        );
    }

    #[test]
    fn preflight_skill_activation_item_skips_disabled_skill() {
        let skills = vec![test_skill(
            IMAGE_PROMPT_OPTIMIZER_SKILL_NAME,
            "chatroom, redclaw, image-generation",
            Some(true),
        )];

        assert_eq!(
            preflight_skill_activation_item(&skills, "redclaw", IMAGE_PROMPT_OPTIMIZER_SKILL_NAME,),
            None
        );
    }

    #[test]
    fn build_video_project_relative_path_uses_timestamp_file_name_by_default() {
        let path = build_video_project_relative_path(None);

        assert!(path.starts_with("video/"));
        assert!(path.ends_with(VIDEO_DRAFT_EXTENSION));
        assert!(path
            .trim_start_matches("video/")
            .trim_end_matches(VIDEO_DRAFT_EXTENSION)
            .chars()
            .all(|ch| ch.is_ascii_digit()));
    }

    #[test]
    fn build_video_project_relative_path_preserves_parent_but_replaces_file_name() {
        let path = build_video_project_relative_path(Some(
            "video/custom/Jamba 戴森V8舞蹈视频.redvideo".to_string(),
        ));

        assert!(path.starts_with("video/custom/"));
        assert!(path.ends_with(VIDEO_DRAFT_EXTENSION));
        assert!(path
            .trim_start_matches("video/custom/")
            .trim_end_matches(VIDEO_DRAFT_EXTENSION)
            .chars()
            .all(|ch| ch.is_ascii_digit()));
    }

    #[test]
    fn tokenize_command_keeps_rest_of_unclosed_quoted_prompt() {
        let tokens = tokenize_command(
            "video generate --mode reference-guided --prompt \"Jamba 手持戴森 V8 吸尘器跳舞",
        );

        assert_eq!(tokens[0], "video");
        assert_eq!(tokens[1], "generate");
        assert_eq!(tokens[2], "--mode");
        assert_eq!(tokens[3], "reference-guided");
        assert_eq!(tokens[4], "--prompt");
        assert_eq!(tokens[5], "Jamba 手持戴森 V8 吸尘器跳舞");
    }

    #[test]
    fn video_project_create_requested_explicitly_accepts_cli_and_payload_flags() {
        let cli_args = parse_cli_args(&[
            "--explicit-project-workflow".to_string(),
            "true".to_string(),
        ])
        .expect("cli args should parse");
        assert!(video_project_create_requested_explicitly(
            &cli_args,
            &json!({})
        ));

        assert!(video_project_create_requested_explicitly(
            &CliArgs::default(),
            &json!({ "explicitProjectWorkflow": true })
        ));
        assert!(video_project_create_requested_explicitly(
            &CliArgs::default(),
            &json!({ "confirmProjectWorkflow": "yes" })
        ));
        assert!(!video_project_create_requested_explicitly(
            &CliArgs::default(),
            &json!({})
        ));
    }

    #[test]
    fn extract_video_project_reference_images_reads_project_assets() {
        let refs = extract_video_project_reference_images(
            &json!({
                "project": {
                    "assets": [
                        { "absolutePath": "/tmp/demo.png", "mimeType": "image/png" },
                        { "absolutePath": "/tmp/demo.mp4", "mimeType": "video/mp4" }
                    ]
                }
            }),
            5,
        );

        assert_eq!(refs, vec!["/tmp/demo.png".to_string()]);
    }

    #[test]
    fn parse_storyboard_markdown_reads_standard_table() {
        let shots = parse_storyboard_markdown(
            r#"
视频时长：6 秒

| Time | Picture | Sound | Shot |
| --- | --- | --- | --- |
| 0-2s | Jamba 手持吸尘器左右摇摆 | 轻快节奏配音 | 中景，全身 |
| 2-4s | 一边跳舞一边挥舞吸尘器 | 节奏音乐 + 人声 | 中近景，跟拍 |
"#,
        );

        assert_eq!(shots.len(), 2);
        assert_eq!(shots[0].time, "0-2s");
        assert_eq!(shots[0].picture, "Jamba 手持吸尘器左右摇摆");
        assert_eq!(shots[1].shot, "中近景，跟拍");
    }

    #[test]
    fn compile_video_generation_prompt_includes_storyboard_beats() {
        let prompt = compile_video_generation_prompt(
            &json!({
                "prompt": "Jamba 手持戴森 V8 吸尘器跳舞，整体轻快有趣。",
                "generationMode": "reference-guided",
                "aspectRatio": "9:16",
                "durationSeconds": 6,
                "referenceImages": ["/tmp/jamba.jpg", "/tmp/dyson.jpg"],
                "referenceImageLabels": ["Jamba 人物主体参考", "戴森 V8 产品参考"],
                "drivingAudio": "/tmp/jamba.webm",
                "drivingAudioLabel": "Jamba 声音参考，用于节奏和语气",
                "storyboardShots": [
                    {
                        "time": "0-2s",
                        "picture": "Jamba 手持戴森 V8 吸尘器，身体随节奏左右摇摆。",
                        "sound": "Jamba 声音参考配音，轻快节奏感。",
                        "shot": "中景，人物全身入镜。"
                    },
                    {
                        "time": "2-4s",
                        "picture": "Jamba 一边跳舞一边用吸尘器做挥舞动作。",
                        "sound": "节奏感音乐 + Jamba 声音。",
                        "shot": "中近景，跟随人物移动。"
                    }
                ]
            }),
            None,
        )
        .expect("storyboard prompt should compile");

        assert!(prompt.contains("Image 1: Jamba 人物主体参考"));
        assert!(prompt
            .contains("Beat 1 (0-2s): Picture: Jamba 手持戴森 V8 吸尘器，身体随节奏左右摇摆。"));
        assert!(prompt.contains("Follow the beat order exactly; do not collapse the storyboard into one generic summary."));
        assert!(
            prompt.contains("Align body rhythm, lip-sync feel, and timing accents with Audio 1.")
        );
    }

    #[test]
    fn compile_video_generation_prompt_uses_confirmed_project_script() {
        let prompt = compile_video_generation_prompt(
            &json!({
                "prompt": "生成视频",
                "generationMode": "reference-guided",
                "aspectRatio": "9:16",
                "durationSeconds": 6
            }),
            Some(&json!({
                "project": {
                    "scriptBody": r#"
| 时间 | 画面 | 声音 | 景别 |
| --- | --- | --- | --- |
| 0-2s | Jamba 左右摇摆 | 轻快配音 | 中景 |
"#,
                    "scriptApproval": {
                        "status": "confirmed"
                    }
                }
            })),
        )
        .expect("confirmed project script should compile");

        assert!(
            prompt.contains("Beat 1 (0-2s): Picture: Jamba 左右摇摆; Sound: 轻快配音; Shot: 中景.")
        );
    }

    #[test]
    fn build_generation_payload_normalizes_video_payload_aliases() {
        let merged = build_generation_payload(
            &CliArgs::default(),
            &json!({
                "prompt": "生成视频",
                "mode": "reference-guided",
                "duration": 6,
                "ratio": "9:16",
                "referenceImages": ["/tmp/jamba.jpg", "/tmp/dyson.jpg"]
            }),
        );

        assert_eq!(
            payload_string(&merged, "generationMode"),
            Some("reference-guided".to_string())
        );
        assert_eq!(
            payload_field(&merged, "durationSeconds").and_then(Value::as_i64),
            Some(6)
        );
        assert_eq!(
            payload_string(&merged, "aspectRatio"),
            Some("9:16".to_string())
        );
    }
}
