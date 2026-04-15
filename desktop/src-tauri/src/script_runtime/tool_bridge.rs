use std::fs;

use serde_json::{json, Value};
use tauri::{AppHandle, State};

use crate::commands;
use crate::persistence::with_store;
use crate::script_runtime::limits::ScriptExecutionLimits;
use crate::{
    ensure_store_hydrated_for_advisors, ensure_store_hydrated_for_knowledge,
    ensure_store_hydrated_for_work, list_directory_entries, payload_field, payload_string,
    resolve_editor_tool_file_path, resolve_workspace_tool_path, runtime_recall_value, text_snippet,
    AppState, McpServerRecord,
};

pub trait ScriptToolBridge {
    fn call(&mut self, tool: &str, input: Value) -> Result<Value, String>;
}

pub struct RealScriptToolBridge<'a> {
    app: &'a AppHandle,
    state: &'a State<'a, AppState>,
    runtime_mode: &'a str,
    session_id: Option<&'a str>,
    limits: &'a ScriptExecutionLimits,
}

impl<'a> RealScriptToolBridge<'a> {
    pub fn new(
        app: &'a AppHandle,
        state: &'a State<'a, AppState>,
        runtime_mode: &'a str,
        session_id: Option<&'a str>,
        limits: &'a ScriptExecutionLimits,
    ) -> Self {
        Self {
            app,
            state,
            runtime_mode,
            session_id,
            limits,
        }
    }

    fn runtime_mode(&self) -> &str {
        self.runtime_mode
    }

    fn normalize_success_result(value: Value) -> Result<Value, String> {
        if value
            .get("success")
            .and_then(Value::as_bool)
            .map(|success| !success)
            .unwrap_or(false)
        {
            return Err(payload_string(&value, "error")
                .unwrap_or_else(|| "script runtime tool call failed".to_string()));
        }
        Ok(value)
    }

    fn app_query(&self, input: &Value) -> Result<Value, String> {
        let operation = payload_string(input, "operation")
            .ok_or_else(|| "operation is required".to_string())?;
        let limit = payload_field(input, "limit")
            .and_then(Value::as_u64)
            .map(|value| value as usize)
            .unwrap_or(8)
            .clamp(1, 20);
        let query = payload_string(input, "query")
            .unwrap_or_default()
            .to_lowercase();
        let status_filter = payload_string(input, "status");
        match operation.as_str() {
            "spaces.list" => with_store(self.state, |store| {
                Ok(json!({
                    "spaces": store.spaces.iter().map(|item| json!({
                        "id": item.id,
                        "name": item.name,
                        "isActive": item.id == store.active_space_id,
                        "updatedAt": item.updated_at
                    })).collect::<Vec<_>>()
                }))
            }),
            "advisors.list" => {
                let _ = ensure_store_hydrated_for_advisors(self.state);
                with_store(self.state, |store| {
                    let mut items = store.advisors.clone();
                    items.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
                    Ok(json!({
                        "advisors": items.into_iter().take(limit).map(|item| json!({
                            "id": item.id,
                            "name": item.name,
                            "personality": item.personality,
                            "knowledgeLanguage": item.knowledge_language,
                            "knowledgeFileCount": item.knowledge_files.len(),
                            "updatedAt": item.updated_at
                        })).collect::<Vec<_>>()
                    }))
                })
            }
            "knowledge.search" => {
                let _ = ensure_store_hydrated_for_knowledge(self.state);
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
                    for source in &store.document_sources {
                        let haystack = format!(
                            "{}\n{}\n{}",
                            source.name,
                            source.root_path,
                            source.sample_files.join("\n")
                        )
                        .to_lowercase();
                        if haystack.contains(&query) {
                            hits.push(json!({
                                "kind": "document-source",
                                "id": source.id,
                                "title": source.name,
                                "snippet": text_snippet(&source.sample_files.join(", "), 220),
                                "rootPath": source.root_path,
                            }));
                        }
                    }
                    Ok(json!({
                        "results": hits.into_iter().take(limit).collect::<Vec<_>>()
                    }))
                })
            }
            "work.list" => {
                let _ = ensure_store_hydrated_for_work(self.state);
                with_store(self.state, |store| {
                    let mut items = store.work_items.clone();
                    items.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
                    Ok(json!({
                        "workItems": items.into_iter()
                            .filter(|item| status_filter.as_ref().map(|status| &item.status == status).unwrap_or(true))
                            .take(limit)
                            .map(|item| json!({
                                "id": item.id,
                                "title": item.title,
                                "status": item.status,
                                "summary": item.summary,
                                "type": item.r#type,
                                "updatedAt": item.updated_at
                            }))
                            .collect::<Vec<_>>()
                    }))
                })
            }
            "memory.search" => {
                let response = runtime_recall_value(
                    self.state,
                    &json!({
                        "query": query,
                        "sources": ["memory"],
                        "limit": limit,
                        "maxChars": self.limits.max_recall_chars,
                    }),
                )?;
                Ok(json!({
                    "memories": response
                        .get("hits")
                        .and_then(Value::as_array)
                        .cloned()
                        .unwrap_or_default()
                }))
            }
            "chat.sessions.list" => with_store(self.state, |store| {
                let mut items = store.chat_sessions.clone();
                items.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
                Ok(json!({
                    "sessions": items.into_iter().take(limit).map(|item| json!({
                        "id": item.id,
                        "title": item.title,
                        "updatedAt": item.updated_at
                    })).collect::<Vec<_>>()
                }))
            }),
            "settings.summary" => with_store(self.state, |store| {
                let default_ai_source_id = payload_string(&store.settings, "default_ai_source_id");
                let model_name = payload_string(&store.settings, "model_name");
                let api_endpoint = payload_string(&store.settings, "api_endpoint");
                Ok(json!({
                    "defaultAiSourceId": default_ai_source_id,
                    "modelName": model_name,
                    "apiEndpoint": api_endpoint,
                    "hasApiKey": payload_string(&store.settings, "api_key").map(|value| !value.trim().is_empty()).unwrap_or(false),
                    "hasEmbeddingKey": payload_string(&store.settings, "embedding_key").map(|value| !value.trim().is_empty()).unwrap_or(false),
                    "hasMcpConfig": payload_string(&store.settings, "mcp_servers_json").map(|value| value != "[]" && !value.trim().is_empty()).unwrap_or(false)
                }))
            }),
            "redclaw.projects.list" => with_store(self.state, |store| {
                Ok(json!({
                    "projects": store.redclaw_state.projects.iter().take(limit).map(|item| json!({
                        "id": item.id,
                        "goal": item.goal,
                        "platform": item.platform,
                        "taskType": item.task_type,
                        "status": item.status,
                        "updatedAt": item.updated_at
                    })).collect::<Vec<_>>()
                }))
            }),
            _ => Err(format!(
                "unsupported script runtime app.query operation: {operation}"
            )),
        }
    }

    fn fs_list(&self, input: &Value) -> Result<Value, String> {
        let raw_path = payload_string(input, "path").unwrap_or_default();
        let limit = payload_field(input, "limit")
            .and_then(Value::as_u64)
            .map(|value| value as usize)
            .unwrap_or(20)
            .clamp(1, self.limits.max_fs_list_entries);
        let resolved = resolve_workspace_tool_path(self.state, &raw_path)?;
        if !resolved.is_dir() {
            return Err(format!("not a directory: {}", resolved.display()));
        }
        Ok(json!({
            "path": resolved.display().to_string(),
            "entries": list_directory_entries(&resolved, limit)?
        }))
    }

    fn fs_read(&self, input: &Value) -> Result<Value, String> {
        let raw_path = payload_string(input, "path").unwrap_or_default();
        let max_chars = payload_field(input, "maxChars")
            .and_then(Value::as_u64)
            .map(|value| value as usize)
            .unwrap_or(self.limits.max_fs_read_chars)
            .clamp(200, self.limits.max_fs_read_chars);
        let resolved = resolve_workspace_tool_path(self.state, &raw_path)?;
        if !resolved.is_file() {
            return Err(format!("not a file: {}", resolved.display()));
        }
        let content = fs::read_to_string(&resolved).map_err(|error| error.to_string())?;
        Ok(json!({
            "path": resolved.display().to_string(),
            "content": crate::truncate_chars(&content, max_chars)
        }))
    }

    fn memory_recall(&self, input: &Value) -> Result<Value, String> {
        let query = payload_string(input, "query").unwrap_or_default();
        let limit = payload_field(input, "limit")
            .and_then(Value::as_u64)
            .map(|value| value as usize)
            .unwrap_or(self.limits.max_recall_hits.min(6))
            .clamp(1, self.limits.max_recall_hits);
        let max_chars = payload_field(input, "maxChars")
            .and_then(Value::as_u64)
            .map(|value| value as usize)
            .unwrap_or(self.limits.max_recall_chars)
            .clamp(500, self.limits.max_recall_chars);
        runtime_recall_value(
            self.state,
            &json!({
                "query": query,
                "sessionId": payload_string(input, "sessionId").or_else(|| self.session_id.map(ToString::to_string)),
                "runtimeId": payload_string(input, "runtimeId"),
                "sources": payload_field(input, "sources").cloned().unwrap_or_else(|| json!(["memory", "checkpoint"])),
                "memoryTypes": payload_field(input, "memoryTypes").cloned().unwrap_or_else(|| json!([])),
                "includeArchived": payload_field(input, "includeArchived").cloned().unwrap_or_else(|| json!(false)),
                "includeChildSessions": payload_field(input, "includeChildSessions").cloned().unwrap_or_else(|| json!(false)),
                "limit": limit,
                "maxChars": max_chars,
            }),
        )
    }

    fn editor_read(&self, tool: &str, input: &Value) -> Result<Value, String> {
        if self.runtime_mode() != "video-editor" {
            return Err(
                "editor script runtime tools are only enabled in video-editor mode".to_string(),
            );
        }
        let file_path = resolve_editor_tool_file_path(self.state, self.session_id, input)?;
        let (channel, payload) = match tool {
            "editor.script_read" => (
                "manuscripts:get-package-script-state",
                json!({ "filePath": file_path }),
            ),
            "editor.project_read" => (
                "manuscripts:get-video-project-state",
                json!({ "filePath": file_path }),
            ),
            "editor.remotion_read" => (
                "manuscripts:get-remotion-context",
                json!({ "filePath": file_path }),
            ),
            _ => return Err(format!("unsupported editor script runtime tool: {tool}")),
        };
        let value = commands::manuscripts::handle_manuscripts_channel(
            self.app, self.state, channel, &payload,
        )
        .unwrap_or_else(|| Err(format!("Manuscript channel not handled: {channel}")))?;
        Self::normalize_success_result(value)
    }

    fn resolve_mcp_server(&self, input: &Value) -> Result<McpServerRecord, String> {
        let server_id = payload_string(input, "serverId").unwrap_or_default();
        let server_name = payload_string(input, "serverName").unwrap_or_default();
        with_store(self.state, |store| {
            store
                .mcp_servers
                .iter()
                .find(|server| {
                    (!server_id.trim().is_empty() && server.id == server_id)
                        || (!server_name.trim().is_empty() && server.name == server_name)
                })
                .cloned()
                .ok_or_else(|| "script runtime MCP server not found".to_string())
        })
    }

    fn mcp_read(&self, tool: &str, input: &Value) -> Result<Value, String> {
        if self.runtime_mode() == "video-editor" {
            return Err(
                "MCP script runtime tools are not enabled in video-editor mode".to_string(),
            );
        }
        match tool {
            "mcp.list_servers" => with_store(self.state, |store| {
                Ok(json!({
                    "servers": store.mcp_servers.iter().map(|server| json!({
                        "id": server.id,
                        "name": server.name,
                        "enabled": server.enabled,
                        "transport": server.transport,
                    })).collect::<Vec<_>>()
                }))
            }),
            "mcp.list_tools" => {
                let server = self.resolve_mcp_server(input)?;
                let value = commands::mcp_tools::mcp_list_tools_value(
                    self.state,
                    &server,
                    self.session_id.map(ToString::to_string),
                )?;
                Self::normalize_success_result(value)
            }
            "mcp.list_resources" => {
                let server = self.resolve_mcp_server(input)?;
                let value = commands::mcp_tools::mcp_list_resources_value(
                    self.state,
                    &server,
                    self.session_id.map(ToString::to_string),
                )?;
                Self::normalize_success_result(value)
            }
            "mcp.list_resource_templates" => {
                let server = self.resolve_mcp_server(input)?;
                let value = commands::mcp_tools::mcp_list_resource_templates_value(
                    self.state,
                    &server,
                    self.session_id.map(ToString::to_string),
                )?;
                Self::normalize_success_result(value)
            }
            _ => Err(format!("unsupported MCP script runtime tool: {tool}")),
        }
    }
}

impl<'a> ScriptToolBridge for RealScriptToolBridge<'a> {
    fn call(&mut self, tool: &str, input: Value) -> Result<Value, String> {
        match tool {
            "app.query" => self.app_query(&input),
            "fs.list" => self.fs_list(&input),
            "fs.read" => self.fs_read(&input),
            "memory.recall" => self.memory_recall(&input),
            "editor.script_read" | "editor.project_read" | "editor.remotion_read" => {
                self.editor_read(tool, &input)
            }
            "mcp.list_servers"
            | "mcp.list_tools"
            | "mcp.list_resources"
            | "mcp.list_resource_templates" => self.mcp_read(tool, &input),
            _ => Err(format!("unsupported script runtime tool: {tool}")),
        }
    }
}
