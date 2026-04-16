use serde_json::{json, Map, Value};
use tauri::{AppHandle, State};

use crate::commands;
use crate::helpers::{ensure_manuscript_file_name, normalize_relative_path, VIDEO_DRAFT_EXTENSION};
use crate::interactive_runtime_shared::text_snippet;
use crate::persistence::with_store;
use crate::{payload_field, payload_string, AppState};

pub struct AppCliExecutor<'a> {
    app: &'a AppHandle,
    state: &'a State<'a, AppState>,
    runtime_mode: &'a str,
    session_id: Option<&'a str>,
}

#[derive(Debug, Clone, Default)]
struct CliArgs {
    positionals: Vec<String>,
    options: Map<String, Value>,
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
    ) -> Self {
        Self {
            app,
            state,
            runtime_mode,
            session_id,
        }
    }

    pub fn execute(&self, arguments: &Value) -> Result<Value, String> {
        let command = payload_string(arguments, "command")
            .ok_or_else(|| "command is required".to_string())?;
        let payload = payload_field(arguments, "payload")
            .cloned()
            .unwrap_or_else(|| json!({}));
        let tokens = shell_words::split(&command).map_err(|error| error.to_string())?;
        if tokens.is_empty() {
            return Err("command is empty".to_string());
        }

        match tokens[0].as_str() {
            "help" => Ok(help_response(tokens.get(1).map(String::as_str))),
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
            "settings" => self.handle_settings(&tokens[1..], &payload),
            "skills" => self.handle_skills(&tokens[1..], &payload),
            "mcp" => self.handle_mcp(&tokens[1..], &payload),
            other => Err(format!("unsupported app_cli namespace: {other}")),
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
                let mut merged = merge_payload(&args.options, payload);
                if let Some(object) = merged.as_object_mut() {
                    object.insert("path".to_string(), json!(path));
                    if !object.contains_key("content") {
                        object.insert(
                            "content".to_string(),
                            json!(args.string(&["content"]).unwrap_or_default()),
                        );
                    }
                }
                self.call_channel("manuscripts:save", merged)
            }
            "create" => {
                let relative = args
                    .string(&["path"])
                    .or_else(|| args.positionals.first().cloned())
                    .ok_or_else(|| "manuscripts create requires --path".to_string())?;
                let normalized =
                    ensure_manuscript_file_name(&normalize_relative_path(&relative), ".md");
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
            "generate" => self.call_channel(
                "image-gen:generate",
                build_generation_payload(&args, payload),
            ),
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
            "generate" => self.call_channel(
                "video-gen:generate",
                build_generation_payload(&args, payload),
            ),
            "project-create" => self.handle_video_project_create(&args, payload),
            "project-list" => self.handle_video_project_list(),
            "project-get" => self.handle_video_project_get(&args),
            "project-brief" => self.handle_video_project_brief(&args),
            "project-script" => self.handle_video_project_script(&args, payload),
            "project-asset-add" => self.handle_video_project_asset_add(&args),
            _ => Err(format!("unsupported video action: {action}")),
        }
    }

    fn handle_knowledge(&self, tokens: &[String], _payload: &Value) -> Result<Value, String> {
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
                    .or_else(|| {
                        if args.positionals.is_empty() {
                            None
                        } else {
                            Some(args.positionals.join(" "))
                        }
                    })
                    .unwrap_or_default()
                    .to_lowercase();
                let limit = args.i64(&["limit"]).unwrap_or(8).clamp(1, 20) as usize;
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
            "list" => self.call_channel("work:list", json!({})),
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
            "list-projects" | "projects" => self.call_channel("redclaw:list-projects", json!({})),
            "runner-status" => self.call_channel("redclaw:runner-status", json!({})),
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
            _ => Err(format!("unsupported redclaw action: {action}")),
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
            "disable" => self.call_channel(
                "skills:disable",
                json!({
                    "name": args
                        .string(&["name"])
                        .or_else(|| args.positionals.first().cloned())
                        .ok_or_else(|| "skills disable requires --name".to_string())?
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
            _ => Err(format!("unsupported mcp action: {action}")),
        }
    }

    fn handle_video_project_create(
        &self,
        args: &CliArgs,
        payload: &Value,
    ) -> Result<Value, String> {
        let title = args
            .string(&["title"])
            .or_else(|| args.positionals.first().cloned())
            .unwrap_or_else(|| "Untitled Video".to_string());
        let relative = args
            .string(&["path"])
            .map(|value| {
                ensure_manuscript_file_name(&normalize_relative_path(&value), VIDEO_DRAFT_EXTENSION)
            })
            .unwrap_or_else(|| {
                ensure_manuscript_file_name(
                    &format!("video/{}", sanitize_slug(&title)),
                    VIDEO_DRAFT_EXTENSION,
                )
            });
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
        self.call_channel(
            "manuscripts:get-video-project-state",
            json!({
                "filePath": args
                    .string(&["path"])
                    .or_else(|| args.positionals.first().cloned())
                    .ok_or_else(|| "video project-get requires --path".to_string())?
            }),
        )
    }

    fn handle_video_project_brief(&self, args: &CliArgs) -> Result<Value, String> {
        let project = self.handle_video_project_get(args)?;
        Ok(json!({
            "success": project.get("success").and_then(Value::as_bool).unwrap_or(true),
            "manifest": project.get("manifest").cloned().unwrap_or(Value::Null),
            "videoProject": project.get("videoProject").cloned().unwrap_or(Value::Null),
            "timelineSummary": project.get("timelineSummary").cloned().unwrap_or(Value::Null),
            "script": project.get("script").cloned().unwrap_or(Value::Null),
            "assets": project.pointer("/assets/items").cloned().unwrap_or_else(|| json!([]))
        }))
    }

    fn handle_video_project_script(
        &self,
        args: &CliArgs,
        payload: &Value,
    ) -> Result<Value, String> {
        let path = args
            .string(&["path"])
            .or_else(|| args.positionals.first().cloned())
            .ok_or_else(|| "video project-script requires --path".to_string())?;
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

    fn handle_video_project_asset_add(&self, args: &CliArgs) -> Result<Value, String> {
        self.call_channel(
            "manuscripts:add-package-clip",
            json!({
                "filePath": args
                    .string(&["path"])
                    .or_else(|| args.positionals.first().cloned())
                    .ok_or_else(|| "video project-asset-add requires --path".to_string())?,
                "assetId": args
                    .string(&["asset-id", "assetId"])
                    .or_else(|| args.positionals.get(1).cloned())
                    .ok_or_else(|| "video project-asset-add requires --asset-id".to_string())?,
                "track": args.string(&["track"]),
                "order": args.i64(&["order"]),
                "durationMs": args.i64(&["duration-ms", "durationMs"])
            }),
        )
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
        Err(format!("app_cli channel not handled: {channel}"))
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
        args.string(&["generation-mode", "generationMode"]),
    );
    if let Some(count) = args.i64(&["count"]) {
        merged.insert("count".to_string(), json!(count));
    }
    if let Some(subject_ids) = comma_list_value(args.value(&["subject-ids", "subjectIds"])) {
        merged.insert("subjectIds".to_string(), subject_ids);
    }
    if let Some(reference_images) =
        comma_list_value(args.value(&["reference-images", "referenceImages"]))
    {
        merged.insert("referenceImages".to_string(), reference_images);
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

fn sanitize_slug(title: &str) -> String {
    let mut result = title
        .chars()
        .map(|ch| match ch {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '-',
            _ => ch,
        })
        .collect::<String>()
        .trim()
        .to_string();
    if result.is_empty() {
        result = "untitled-video".to_string();
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
            "spaces list|get|create|rename|switch",
            "subjects list|get|search|categories list|create|update|delete",
            "manuscripts list|read|write|create|delete",
            "media list|get|update|bind|delete",
            "image generate|history list|get|providers|models",
            "video generate|project-create|project-list|project-get|project-brief|project-script|project-asset-add",
            "knowledge list|search",
            "work list|ready|get|update",
            "memory list|search|add|delete",
            "redclaw projects|runner-status|runner-start|runner-stop|runner-set-config|profile-bundle|profile-read|profile-update",
            "settings summary|get|set",
            "skills list|invoke|enable|disable",
            "mcp list|sessions|oauth-status|save",
        ],
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
        ],
        "media" => vec![
            "media list",
            "media get --id <assetId>",
            "media update --asset-id <assetId> [--title ...]",
            "media bind --asset-id <assetId> --manuscript-path <path>",
            "media delete --asset-id <assetId>",
        ],
        "image" => vec![
            "image generate --prompt \"...\" [--subject-ids a,b]",
            "image history list",
            "image history get --id <assetId>",
            "image providers",
            "image models",
        ],
        "video" => vec![
            "video generate --prompt \"...\"",
            "video project-create --title \"...\" [--duration 8s] [--aspect-ratio 9:16]",
            "video project-list",
            "video project-get --path <relativePath>",
            "video project-brief --path <relativePath>",
            "video project-script --path <relativePath> [payload.content]",
            "video project-asset-add --path <relativePath> --asset-id <assetId>",
        ],
        "knowledge" => vec![
            "knowledge list",
            "knowledge search --query \"keyword\"",
        ],
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
            "redclaw projects",
            "redclaw runner-status",
            "redclaw runner-start [--interval-minutes 15]",
            "redclaw runner-stop",
            "redclaw runner-set-config [payload]",
            "redclaw profile-bundle",
            "redclaw profile-read --doc-type user",
            "redclaw profile-update --doc-type user [payload.markdown]",
        ],
        "settings" => vec![
            "settings summary",
            "settings get",
            "settings set [payload]",
        ],
        "skills" => vec![
            "skills list",
            "skills invoke --name <skill>",
            "skills enable --name <skill>",
            "skills disable --name <skill>",
        ],
        "mcp" => vec![
            "mcp list",
            "mcp sessions",
            "mcp oauth-status --id <serverId>",
            "mcp save [payload]",
        ],
        _ => vec!["help"],
    };
    json!({
        "success": true,
        "namespace": namespace,
        "commands": commands,
    })
}
