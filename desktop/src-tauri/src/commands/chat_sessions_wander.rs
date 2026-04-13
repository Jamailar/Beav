use crate::persistence::{with_store, with_store_mut};
use crate::runtime::{
    checkpoint_count_for_session, runtime_direct_route_record, session_detail_value,
    session_list_item_value, session_resume_value, tool_results_for_session, trace_for_session,
    transcript_count_for_session, RuntimeArtifact, RuntimeCheckpointRecord, RuntimeRouteRecord,
};
use crate::*;
use serde_json::{json, Value};
use std::fs;
use tauri::{AppHandle, Emitter, State};

pub fn handle_chat_sessions_wander_channel(
    app: &AppHandle,
    state: &State<'_, AppState>,
    channel: &str,
    payload: &Value,
) -> Option<Result<Value, String>> {
    if !matches!(
        channel,
        "chat:getOrCreateFileSession"
            | "chat:getOrCreateContextSession"
            | "chat:get-sessions"
            | "sessions:list"
            | "sessions:get"
            | "sessions:resume"
            | "sessions:fork"
            | "sessions:get-transcript"
            | "sessions:get-tool-results"
            | "chat:get-messages"
            | "chat:create-session"
            | "chat:delete-session"
            | "chat:clear-messages"
            | "chat:compact-context"
            | "chat:get-context-usage"
            | "chat:update-session-metadata"
            | "chat:pick-attachment"
            | "chat:transcribe-audio"
            | "wander:list-history"
            | "wander:delete-history"
            | "wander:get-random"
            | "wander:brainstorm"
    ) {
        return None;
    }

    Some((|| -> Result<Value, String> {
        match channel {
            "chat:getOrCreateFileSession" => {
                let file_path = payload_string(&payload, "filePath").unwrap_or_default();
                let session_key = format!("file-session:{}", slug_from_relative_path(&file_path));
                let title = title_from_relative_path(&file_path);
                let session = with_store_mut(state, |store| {
                    let (session, _) = ensure_chat_session(
                        &mut store.chat_sessions,
                        Some(session_key),
                        Some(title),
                    );
                    Ok(session.clone())
                })?;
                Ok(json!(session))
            }
            "chat:getOrCreateContextSession" => {
                let context_id = payload_string(&payload, "contextId")
                    .unwrap_or_else(|| make_id("context").to_string());
                let context_type = payload_string(&payload, "contextType")
                    .unwrap_or_else(|| "context".to_string());
                let title =
                    payload_string(&payload, "title").unwrap_or_else(|| "New Chat".to_string());
                let session_id = format!(
                    "context-session:{context_type}:{}",
                    slug_from_relative_path(&context_id)
                );
                let session = with_store_mut(state, |store| {
                    let (session, _) = ensure_chat_session(
                        &mut store.chat_sessions,
                        Some(session_id),
                        Some(title),
                    );
                    session.metadata = Some(json!({
                        "contextType": context_type,
                        "contextId": context_id,
                        "isContextBound": true
                    }));
                    session.updated_at = now_iso();
                    Ok(session.clone())
                })?;
                Ok(json!(session))
            }
            "chat:get-sessions" => with_store(state, |store| {
                let mut sessions = store.chat_sessions.clone();
                sessions.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
                Ok(json!(sessions))
            }),
            "sessions:list" => with_store(state, |store| {
                let started_at = now_ms();
                let request_id = format!("sessions:list:{}", started_at);
                let mut sessions = store.chat_sessions.clone();
                sessions.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
                let items: Vec<Value> = sessions
                    .into_iter()
                    .map(|session| session_list_item_value(&store, &session))
                    .collect();
                log_timing_event(
                    state,
                    "settings",
                    &request_id,
                    "sessions:list",
                    started_at,
                    Some(format!("sessions={}", items.len())),
                );
                Ok(json!(items))
            }),
            "sessions:get" => {
                let session_id = payload_string(&payload, "sessionId").unwrap_or_default();
                with_store(state, |store| Ok(session_detail_value(&store, &session_id)))
            }
            "sessions:resume" => {
                let session_id = payload_string(&payload, "sessionId").unwrap_or_default();
                with_store(state, |store| Ok(session_resume_value(&store, &session_id)))
            }
            "sessions:fork" => {
                let session_id = payload_string(&payload, "sessionId").unwrap_or_default();
                let forked = with_store_mut(state, |store| {
                    let Some(source) = store
                        .chat_sessions
                        .iter()
                        .find(|item| item.id == session_id)
                        .cloned()
                    else {
                        return Ok(json!({ "success": false, "error": "会话不存在" }));
                    };
                    let new_id = make_id("session");
                    let timestamp = now_iso();
                    let new_session = ChatSessionRecord {
                        id: new_id.clone(),
                        title: format!("{} (Fork)", source.title),
                        created_at: timestamp.clone(),
                        updated_at: timestamp.clone(),
                        metadata: source.metadata.clone(),
                    };
                    store.chat_sessions.push(new_session.clone());
                    for item in store
                        .chat_messages
                        .iter()
                        .filter(|entry| entry.session_id == source.id)
                        .cloned()
                        .collect::<Vec<_>>()
                    {
                        let mut copy = item.clone();
                        copy.id = make_id("message");
                        copy.session_id = new_id.clone();
                        copy.created_at = timestamp.clone();
                        store.chat_messages.push(copy);
                    }
                    Ok(json!({
                        "success": true,
                        "session": {
                            "id": new_session.id,
                            "transcriptCount": transcript_count_for_session(store, &source.id),
                            "checkpointCount": checkpoint_count_for_session(store, &source.id),
                        }
                    }))
                })?;
                Ok(forked)
            }
            "sessions:get-transcript" => {
                let session_id = payload_string(&payload, "sessionId").unwrap_or_default();
                with_store(state, |store| {
                    Ok(json!(trace_for_session(&store, &session_id)))
                })
            }
            "sessions:get-tool-results" => {
                let session_id = payload_string(&payload, "sessionId").unwrap_or_default();
                with_store(state, |store| {
                    Ok(json!(tool_results_for_session(&store, &session_id)))
                })
            }
            "chat:get-messages" => {
                let session_id = payload_value_as_string(&payload).unwrap_or_default();
                with_store(state, |store| {
                    let mut messages: Vec<ChatMessageRecord> = store
                        .chat_messages
                        .iter()
                        .filter(|item| item.session_id == session_id)
                        .cloned()
                        .collect();
                    messages.sort_by(|a, b| a.created_at.cmp(&b.created_at));
                    Ok(json!(messages))
                })
            }
            "chat:create-session" => {
                let title =
                    payload_value_as_string(&payload).unwrap_or_else(|| "New Chat".to_string());
                let session = with_store_mut(state, |store| {
                    let timestamp = now_iso();
                    let session = ChatSessionRecord {
                        id: make_id("session"),
                        title,
                        created_at: timestamp.clone(),
                        updated_at: timestamp,
                        metadata: None,
                    };
                    store.chat_sessions.push(session.clone());
                    Ok(session)
                })?;
                Ok(json!(session))
            }
            "chat:delete-session" => {
                let session_id = payload_value_as_string(&payload).unwrap_or_default();
                with_store_mut(state, |store| {
                    store.chat_sessions.retain(|item| item.id != session_id);
                    store
                        .chat_messages
                        .retain(|item| item.session_id != session_id);
                    Ok(json!({ "success": true }))
                })
            }
            "chat:clear-messages" => {
                let session_id = payload_value_as_string(&payload).unwrap_or_default();
                with_store_mut(state, |store| {
                    store
                        .chat_messages
                        .retain(|item| item.session_id != session_id);
                    store
                        .session_transcript_records
                        .retain(|item| item.session_id != session_id);
                    store
                        .session_checkpoints
                        .retain(|item| item.session_id != session_id);
                    store
                        .session_tool_results
                        .retain(|item| item.session_id != session_id);
                    Ok(json!({ "success": true }))
                })?;
                if let Ok(mut guard) = state.chat_runtime_states.lock() {
                    guard.remove(&session_id);
                }
                Ok(json!({ "success": true }))
            }
            "chat:compact-context" => Ok(json!({ "success": true })),
            "chat:get-context-usage" => Ok(json!({
                "success": true,
                "estimatedTotalTokens": 0,
                "compactThreshold": 0,
                "compactRatio": 0,
                "compactRounds": 0,
                "compactUpdatedAt": Value::Null,
            })),
            "chat:update-session-metadata" => {
                let session_id = payload_string(&payload, "sessionId").unwrap_or_default();
                let metadata = payload_field(&payload, "metadata").cloned();
                with_store_mut(state, |store| {
                    if let Some(session) = store
                        .chat_sessions
                        .iter_mut()
                        .find(|item| item.id == session_id)
                    {
                        session.metadata = metadata;
                        session.updated_at = now_iso();
                    }
                    Ok(json!({ "success": true }))
                })
            }
            "chat:pick-attachment" => {
                let files = pick_files_native("选择要发送给 AI 的文件", false, false)?;
                let Some(path) = files.into_iter().next() else {
                    return Ok(json!({ "success": true, "canceled": true }));
                };
                let metadata = fs::metadata(&path).map_err(|error| error.to_string())?;
                let (mime_type, kind, direct_upload_eligible) = guess_mime_and_kind(&path);
                let requires_multimodal = kind == "image" || kind == "audio" || kind == "video";
                let attachment = json!({
                    "type": "uploaded-file",
                    "name": path.file_name().and_then(|value| value.to_str()).unwrap_or("attachment"),
                    "ext": path.extension().and_then(|value| value.to_str()).unwrap_or(""),
                    "size": metadata.len(),
                    "absolutePath": path.display().to_string(),
                    "originalAbsolutePath": path.display().to_string(),
                    "localUrl": file_url_for_path(&path),
                    "kind": kind,
                    "mimeType": mime_type,
                    "storageMode": "absolute",
                    "directUploadEligible": direct_upload_eligible,
                    "processingStrategy": if direct_upload_eligible { "direct" } else { "path-reference" },
                    "summary": path.display().to_string(),
                    "requiresMultimodal": requires_multimodal,
                });
                Ok(json!({ "success": true, "canceled": false, "attachment": attachment }))
            }
            "chat:transcribe-audio" => {
                let settings_snapshot = with_store(state, |store| Ok(store.settings.clone()))?;
                let Some(audio_base64) = payload_string(&payload, "audioBase64") else {
                    return Ok(json!({ "success": false, "error": "缺少音频内容" }));
                };
                let mime_type = payload_string(&payload, "mimeType")
                    .unwrap_or_else(|| "audio/webm".to_string());
                let file_name = payload_string(&payload, "fileName")
                    .unwrap_or_else(|| format!("chat-audio-{}.webm", now_ms()));
                let Some((endpoint, api_key, model_name)) =
                    resolve_transcription_settings(&settings_snapshot)
                else {
                    return Ok(
                        json!({ "success": false, "error": "未配置音频转写服务，请先在设置中填写 transcription endpoint/model。" }),
                    );
                };
                let temp_dir = store_root(state)?.join("tmp");
                fs::create_dir_all(&temp_dir).map_err(|error| error.to_string())?;
                let audio_path = temp_dir.join(file_name);
                write_base64_payload_to_file(&audio_base64, &audio_path)?;
                let text = run_curl_transcription(
                    &endpoint,
                    api_key.as_deref(),
                    &model_name,
                    &audio_path,
                    &mime_type,
                )
                .or_else(|_| {
                    let fallback = String::from_utf8_lossy(
                        &std::process::Command::new("file")
                            .arg("-b")
                            .arg(&audio_path)
                            .output()
                            .map(|output| output.stdout)
                            .unwrap_or_default(),
                    )
                    .trim()
                    .to_string();
                    if fallback.is_empty() {
                        Err("语音转写失败".to_string())
                    } else {
                        Ok(format!(
                            "音频已接收，但转写接口不可用。\n\n文件类型：{fallback}"
                        ))
                    }
                })?;
                let _ = fs::remove_file(&audio_path);
                Ok(json!({ "success": true, "text": text }))
            }
            "wander:list-history" => with_store(state, |store| {
                let mut history = store.wander_history.clone();
                history.sort_by(|a, b| b.created_at.cmp(&a.created_at));
                Ok(json!(history))
            }),
            "wander:delete-history" => {
                let history_id = payload_value_as_string(&payload).unwrap_or_default();
                with_store_mut(state, |store| {
                    store.wander_history.retain(|item| item.id != history_id);
                    Ok(json!({ "success": true }))
                })
            }
            "wander:get-random" => with_store(state, |store| {
                let mut items = Vec::new();
                for note in store.knowledge_notes.iter().take(12) {
                    items.push(wander_item_from_note(note));
                }
                for video in store.youtube_videos.iter().take(12) {
                    items.push(wander_item_from_youtube(video));
                }
                for source in store.document_sources.iter().take(12) {
                    items.push(wander_item_from_doc(source));
                }
                items.sort_by_key(|item| {
                    item.get("id")
                        .and_then(|value| value.as_str())
                        .unwrap_or("")
                        .to_string()
                });
                let offset = (now_ms() as usize) % items.len().max(1);
                let mut selected = Vec::new();
                for index in 0..items.len().min(3) {
                    selected.push(items[(offset + index) % items.len()].clone());
                }
                Ok(json!(selected))
            }),
            "wander:brainstorm" => {
                let request_started_at = now_ms();
                let mut items = payload
                    .as_array()
                    .cloned()
                    .or_else(|| {
                        payload_field(&payload, "items").and_then(|value| value.as_array().cloned())
                    })
                    .unwrap_or_default();
                let options = payload
                    .as_array()
                    .and_then(|items| items.get(1))
                    .cloned()
                    .or_else(|| payload_field(&payload, "options").cloned())
                    .unwrap_or_else(|| json!({}));
                let request_id = payload_string(&options, "requestId")
                    .unwrap_or_else(|| make_id("wander-request"));
                log_timing_event(
                    state,
                    "wander",
                    &request_id,
                    "request-received",
                    request_started_at,
                    Some(format!("inputItems={}", items.len())),
                );
                if items.is_empty() {
                    let select_started_at = now_ms();
                    items = with_store(state, |store| {
                        let mut collected = Vec::new();
                        for note in store.knowledge_notes.iter().take(12) {
                            collected.push(wander_item_from_note(note));
                        }
                        for video in store.youtube_videos.iter().take(12) {
                            collected.push(wander_item_from_youtube(video));
                        }
                        for source in store.document_sources.iter().take(12) {
                            collected.push(wander_item_from_doc(source));
                        }
                        collected.sort_by_key(|item| {
                            item.get("id")
                                .and_then(|value| value.as_str())
                                .unwrap_or("")
                                .to_string()
                        });
                        let offset = (now_ms() as usize) % collected.len().max(1);
                        let mut selected = Vec::new();
                        for index in 0..collected.len().min(3) {
                            selected.push(collected[(offset + index) % collected.len()].clone());
                        }
                        Ok(selected)
                    })?;
                    log_timing_event(
                        state,
                        "wander",
                        &request_id,
                        "select-random-items",
                        select_started_at,
                        Some(format!("selectedItems={}", items.len())),
                    );
                }
                let settings_started_at = now_ms();
                let warm_wander = ensure_runtime_warm_entry(state, "wander")?;
                log_timing_event(
                    state,
                    "wander",
                    &request_id,
                    "load-settings",
                    settings_started_at,
                    Some(format!("warmedAt={}", warm_wander.warmed_at)),
                );
                let route_started_at = now_ms();
                let route = runtime_direct_route(
                    "wander",
                    "基于随机知识素材生成新选题",
                    Some(&json!({
                        "intent": "manuscript_creation",
                        "contextType": "wander",
                        "contextId": request_id.clone(),
                        "preferredRole": "copywriter",
                        "forceMultiAgent": false,
                        "forceLongRunningTask": false
                    })),
                );
                log_timing_event(
                    state,
                    "wander",
                    &request_id,
                    "route-ready",
                    route_started_at,
                    Some(format!(
                        "intent={} role={}",
                        payload_string(&route, "intent").unwrap_or_default(),
                        payload_string(&route, "recommendedRole").unwrap_or_default()
                    )),
                );
                let task_started_at = now_ms();
                let task_id = with_store_mut(state, |store| {
                    let typed_route = RuntimeRouteRecord::from_value(&route).unwrap_or_else(|| {
                        runtime_direct_route_record("wander", "漫步生成新选题", None)
                    });
                    let task = RuntimeTaskRecord {
                        id: make_id("task"),
                        runtime_id: None,
                        parent_runtime_id: None,
                        parent_task_id: None,
                        root_task_id: None,
                        child_task_ids: Vec::new(),
                        aggregation_status: None,
                        task_type: "wander".to_string(),
                        status: "running".to_string(),
                        runtime_mode: "wander".to_string(),
                        owner_session_id: Some(format!(
                            "context-session:wander:{}",
                            slug_from_relative_path(&request_id)
                        )),
                        intent: Some(typed_route.intent.clone()),
                        role_id: Some(typed_route.recommended_role.clone()),
                        goal: Some("漫步生成新选题".to_string()),
                        current_node: Some("plan".to_string()),
                        route: Some(typed_route.clone()),
                        graph: runtime_graph_for_route(&route),
                        artifacts: Vec::new(),
                        checkpoints: vec![RuntimeCheckpointRecord::new(
                            "route",
                            "plan",
                            payload_string(&route, "reasoning")
                                .unwrap_or_else(|| "wander route".to_string()),
                            Some(route.clone()),
                        )],
                        metadata: Some(json!({
                            "requestId": request_id.clone(),
                            "contextType": "wander",
                        })),
                        last_error: None,
                        created_at: now_i64(),
                        updated_at: now_i64(),
                        started_at: Some(now_i64()),
                        completed_at: None,
                    };
                    store.runtime_tasks.push(task.clone());
                    append_runtime_task_trace(
                        store,
                        &task.id,
                        "wander.started",
                        Some(json!({ "requestId": request_id.clone() })),
                    );
                    Ok(task.id)
                })?;
                log_timing_event(
                    state,
                    "wander",
                    &request_id,
                    "task-created",
                    task_started_at,
                    Some(format!("taskId={}", task_id)),
                );
                let _ = app.emit(
                "wander:progress",
                json!({
                    "requestId": request_id,
                    "taskId": task_id,
                    "sessionId": format!("session_wander_{}", slug_from_relative_path(&request_id)),
                    "phase": "collect",
                    "stepIndex": 1,
                    "totalSteps": 4,
                    "title": "选择随机素材",
                    "status": "completed",
                    "detail": "已从知识库中选出本轮用于漫步的 3 条随机素材。",
                }),
            );
                emit_runtime_task_node_changed(
                    app,
                    &task_id,
                    Some(&format!("session_wander_{}", slug_from_relative_path(&request_id))),
                    "collect",
                    "completed",
                    Some("已从知识库中选出本轮用于漫步的 3 条随机素材。"),
                    None,
                );
                let _ = with_store_mut(state, |store| {
                    if let Some(task) = store
                        .runtime_tasks
                        .iter_mut()
                        .find(|item| item.id == task_id)
                    {
                        set_runtime_graph_node(
                            &mut task.graph,
                            "plan",
                            "completed",
                            Some("漫步素材已读取".to_string()),
                            None,
                        );
                        set_runtime_graph_node(
                            &mut task.graph,
                            "retrieve",
                            "running",
                            Some("正在整理素材摘要".to_string()),
                            None,
                        );
                        task.current_node = Some("retrieve".to_string());
                        task.updated_at = now_i64();
                    }
                    append_runtime_task_trace(store, &task_id, "wander.collect.completed", None);
                    Ok(())
                });
                let multi_choice = payload_field(&options, "multiChoice")
                    .and_then(|value| value.as_bool())
                    .unwrap_or(false);
                let _ = app.emit(
                "wander:progress",
                json!({
                    "requestId": request_id,
                    "taskId": task_id,
                    "sessionId": format!("session_wander_{}", slug_from_relative_path(&request_id)),
                    "phase": "analyze",
                    "stepIndex": 2,
                    "totalSteps": 4,
                    "title": "构建上下文",
                    "status": "running",
                    "detail": format!("已装载 {} 条随机素材，正在整理素材摘要、长期上下文与已读取文件内容...", items.len()),
                }),
            );
                emit_runtime_task_node_changed(
                    app,
                    &task_id,
                    Some(&format!("session_wander_{}", slug_from_relative_path(&request_id))),
                    "analyze",
                    "running",
                    Some(&format!(
                        "已装载 {} 条随机素材，正在整理素材摘要、长期上下文与已读取文件内容...",
                        items.len()
                    )),
                    None,
                );
                let context_started_at = now_ms();
                let long_term_context = warm_wander
                    .long_term_context
                    .clone()
                    .unwrap_or_else(|| build_wander_long_term_context(state));
                log_timing_event(
                    state,
                    "wander",
                    &request_id,
                    "long-term-context-ready",
                    context_started_at,
                    Some(format!(
                        "profileChars={}",
                        long_term_context.chars().count(),
                    )),
                );
                let wander_session_id =
                    format!("session_wander_{}", slug_from_relative_path(&request_id));
                let materials_context_started_at = now_ms();
                let materials_context =
                    build_wander_materials_context(app, state, &wander_session_id, &items);
                log_timing_event(
                    state,
                    "wander",
                    &request_id,
                    "materials-context-ready",
                    materials_context_started_at,
                    Some(format!(
                        "materialsChars={}",
                        materials_context.chars().count()
                    )),
                );
                let _ = app.emit(
                "wander:progress",
                json!({
                    "requestId": request_id,
                    "taskId": task_id,
                    "sessionId": format!("session_wander_{}", slug_from_relative_path(&request_id)),
                    "phase": "analyze",
                    "stepIndex": 2,
                    "totalSteps": 4,
                    "title": "构建上下文",
                    "status": "completed",
                    "detail": "随机素材摘要与长期上下文已准备完成��Agent 将继续自行读取关键文件。",
                }),
            );
                emit_runtime_task_node_changed(
                    app,
                    &task_id,
                    Some(&format!("session_wander_{}", slug_from_relative_path(&request_id))),
                    "analyze",
                    "completed",
                    Some("随机素材摘要与长期上下文已准备完成，Agent 将继续自行读取关键文件。"),
                    None,
                );
                let items_text = build_wander_items_text(&items);
                let long_term_context_section = if long_term_context.trim().is_empty() {
                    String::new()
                } else {
                    format!(
                    "\n\n## 用户长期上下文（供你参考）\n{}\n\n使用要求：\n- 与长期定位保持一致；\n- 若素材与长期定位冲突，优先选择可落地、可执行的方向。",
                    long_term_context
                )
                };
                let prompt = build_wander_deep_agent_prompt(
                    &items_text,
                    &long_term_context_section,
                    &materials_context,
                    multi_choice,
                );
                log_timing_event(
                    state,
                    "wander",
                    &request_id,
                    "prompt-ready",
                    context_started_at,
                    Some(format!("promptChars={}", prompt.chars().count())),
                );
                let session_started_at = now_ms();
                let _ = with_store_mut(state, |store| {
                    let (session, _) = ensure_chat_session(
                        &mut store.chat_sessions,
                        Some(wander_session_id.clone()),
                        Some("Wander Deep Think".to_string()),
                    );
                    session.metadata = Some(json!({
                        "contextId": format!("wander:{}", request_id),
                        "contextType": "wander",
                        "contextContent": items_text,
                        "isContextBound": true,
                    }));
                    session.updated_at = now_iso();
                    Ok(())
                });
                log_timing_event(
                    state,
                    "wander",
                    &request_id,
                    "session-ready",
                    session_started_at,
                    Some(format!("sessionId={}", wander_session_id)),
                );
                let _ = app.emit(
                    "wander:progress",
                    json!({
                        "requestId": request_id,
                        "taskId": task_id,
                        "sessionId": wander_session_id,
                        "phase": "generate",
                        "stepIndex": 3,
                        "totalSteps": 3,
                        "title": "生成选题",
                        "status": "running",
                        "detail": "正在启动漫步 Agent，并基于已读取的关键素材生成最终选题。",
                    }),
                );
                emit_runtime_task_node_changed(
                    app,
                    &task_id,
                    Some(&wander_session_id),
                    "generate",
                    "running",
                    Some("正在启动漫步 Agent，并基于已读取的关键素材生成最终选题。"),
                    None,
                );
                emit_runtime_stream_start(app, &wander_session_id, "responding", Some("wander"));
                emit_runtime_text_delta(
                    app,
                    &wander_session_id,
                    "thought",
                    "正在综合随机素材、长期上下文与关键文件内容，收敛最终选题方向。",
                );
                let execution_started_at = now_ms();
                let model_result = generate_wander_response(
                    state,
                    &wander_session_id,
                    warm_wander
                        .model_config
                        .as_ref()
                        .ok_or_else(|| "wander model config missing".to_string())?,
                    &prompt,
                )
                .map(|response| {
                    append_debug_log_state(
                        state,
                        format!(
                            "[runtime][wander][{}] single-pass-succeeded",
                            wander_session_id
                        ),
                    );
                    response
                })
                .unwrap_or_else(|error| {
                    append_debug_log_state(
                        state,
                        format!(
                            "[runtime][wander][{}] fallback-local-json | {}",
                            wander_session_id, error
                        ),
                    );
                    let first_title = items
                        .first()
                        .and_then(|item| item.get("title"))
                        .and_then(|value| value.as_str())
                        .unwrap_or("随机素材");
                    json!({
                        "content_direction": "围绕这组素材提炼一个更聚焦、可直接创作的小红书选题。",
                        "thinking_process": ["观察随机素材", "提取共同主题", "形成可执行选题"],
                        "topic": {
                            "title": format!("从{}延展出的内容选题", first_title),
                            "connections": [1, 2, 3]
                        },
                        "selected_index": 0
                    })
                    .to_string()
                });
                log_timing_event(
                    state,
                    "wander",
                    &request_id,
                    "execution-finished",
                    execution_started_at,
                    Some(format!("responseChars={}", model_result.chars().count())),
                );
                let parse_started_at = now_ms();
                let result_value =
                    serde_json::from_str::<Value>(&model_result).unwrap_or_else(|_| {
                        let first_title = items
                            .first()
                            .and_then(|item| item.get("title"))
                            .and_then(|value| value.as_str())
                            .unwrap_or("随机素材");
                        json!({
                            "content_direction": model_result,
                            "thinking_process": ["观察随机素材", "提取共同主题", "形成可执行选题"],
                            "topic": {
                                "title": format!("从{}延展出的内容选题", first_title),
                                "connections": [1, 2, 3]
                            },
                            "selected_index": 0
                        })
                    });
                log_timing_event(
                    state,
                    "wander",
                    &request_id,
                    "result-parsed",
                    parse_started_at,
                    None,
                );
                let result_text =
                    serde_json::to_string(&result_value).map_err(|error| error.to_string())?;
                let history_id = make_id("wander");
                let history_started_at = now_ms();
                with_store_mut(state, |store| {
                    store.chat_messages.push(ChatMessageRecord {
                        id: make_id("message"),
                        session_id: wander_session_id.clone(),
                        role: "user".to_string(),
                        content: prompt.clone(),
                        display_content: None,
                        attachment: None,
                        created_at: now_iso(),
                    });
                    store.chat_messages.push(ChatMessageRecord {
                        id: make_id("message"),
                        session_id: wander_session_id.clone(),
                        role: "assistant".to_string(),
                        content: model_result.clone(),
                        display_content: None,
                        attachment: None,
                        created_at: now_iso(),
                    });
                    append_session_transcript(
                        store,
                        &wander_session_id,
                        "message",
                        "user",
                        prompt.clone(),
                        Some(json!({ "source": "wander" })),
                    );
                    append_session_transcript(
                        store,
                        &wander_session_id,
                        "message",
                        "assistant",
                        model_result.clone(),
                        Some(json!({ "source": "wander" })),
                    );
                    append_session_checkpoint(
                        store,
                        &wander_session_id,
                        "wander-brainstorm",
                        "Wander brainstorm completed".to_string(),
                        Some(json!({ "responsePreview": text_snippet(&model_result, 160) })),
                    );
                    store.wander_history.push(WanderHistoryRecord {
                        id: history_id.clone(),
                        items: serde_json::to_string(&items).map_err(|error| error.to_string())?,
                        result: result_text.clone(),
                        created_at: now_i64(),
                    });
                    if let Some(task) = store
                        .runtime_tasks
                        .iter_mut()
                        .find(|item| item.id == task_id)
                    {
                        set_runtime_graph_node(
                            &mut task.graph,
                            "retrieve",
                            "completed",
                            Some("素材关联分析完成".to_string()),
                            None,
                        );
                        set_runtime_graph_node(
                            &mut task.graph,
                            "execute_tools",
                            "completed",
                            Some("选题生成完成".to_string()),
                            None,
                        );
                        set_runtime_graph_node(
                            &mut task.graph,
                            "save_artifact",
                            "completed",
                            Some("漫步结果已保存到历史".to_string()),
                            None,
                        );
                        task.current_node = Some("save_artifact".to_string());
                        task.status = "completed".to_string();
                        task.completed_at = Some(now_i64());
                        task.updated_at = now_i64();
                        task.artifacts.push(RuntimeArtifact::new(
                            "wander-result",
                            "漫步结果",
                            None,
                            Some(json!({ "historyId": history_id.clone() })),
                            Some(result_value.clone()),
                        ));
                    }
                    append_runtime_task_trace(
                        store,
                        &task_id,
                        "wander.completed",
                        Some(json!({ "historyId": history_id.clone() })),
                    );
                    Ok(())
                })?;
                log_timing_event(
                    state,
                    "wander",
                    &request_id,
                    "history-saved",
                    history_started_at,
                    Some(format!("historyId={}", history_id)),
                );
                let _ = app.emit(
                    "wander:progress",
                    json!({
                        "requestId": request_id,
                        "taskId": task_id,
                        "sessionId": wander_session_id,
                        "phase": "complete",
                        "stepIndex": 3,
                        "totalSteps": 3,
                        "title": "保存结果",
                        "status": "completed",
                        "detail": "漫步完成，结果已写入历史记录。",
                    }),
                );
                emit_runtime_task_node_changed(
                    app,
                    &task_id,
                    Some(&wander_session_id),
                    "complete",
                    "completed",
                    Some("漫步完成，结果已写入历史记录。"),
                    None,
                );
                log_timing_event(
                    state,
                    "wander",
                    &request_id,
                    "request-complete",
                    request_started_at,
                    Some(format!(
                        "taskId={} sessionId={}",
                        task_id, wander_session_id
                    )),
                );
                Ok(json!({ "result": result_text, "historyId": history_id, "items": items }))
            }
            _ => Err(format!(
                "RedBox host does not recognize channel `{channel}`."
            )),
        }
    })())
}
