use crate::commands::chat_state::diagnostics_session_defaults;
use crate::persistence::{with_store, with_store_mut};
use crate::runtime::{
    append_compact_boundary_entry, session_context_usage_value, tool_results_for_session,
    trace_for_session, transcript_resume_messages, transcript_session_list_value,
    transcript_session_meta_by_id, update_session_context_record,
};
use crate::session_manager::{
    create_context_session, create_session, delete_session, ensure_context_session, fork_session,
    list_context_sessions, list_sessions, resolve_resume_target_session_id, session_detail_value,
    session_list_item_value, session_resume_value, update_metadata,
};
use crate::*;
use serde_json::{json, Value};
use std::fs;
use tauri::{AppHandle, Emitter, State};

fn xorshift64(mut seed: u64) -> u64 {
    if seed == 0 {
        seed = 0x9E37_79B9_7F4A_7C15;
    }
    seed ^= seed << 13;
    seed ^= seed >> 7;
    seed ^= seed << 17;
    seed
}

fn shuffle_wander_items(items: &mut [Value], seed: u64) {
    if items.len() <= 1 {
        return;
    }
    let mut state = seed;
    for index in (1..items.len()).rev() {
        state = xorshift64(state);
        let swap_index = (state as usize) % (index + 1);
        items.swap(index, swap_index);
    }
}

fn collect_wander_candidate_items(store: &AppStore) -> Vec<Value> {
    let mut items = Vec::new();
    for note in &store.knowledge_notes {
        items.push(wander_item_from_note(note));
    }
    for video in &store.youtube_videos {
        items.push(wander_item_from_youtube(video));
    }
    for source in &store.document_sources {
        items.push(wander_item_from_doc(source));
    }
    items
}

fn pick_random_wander_items(mut items: Vec<Value>, count: usize) -> Vec<Value> {
    items.sort_by_key(|item| {
        item.get("id")
            .and_then(|value| value.as_str())
            .unwrap_or("")
            .to_string()
    });
    shuffle_wander_items(&mut items, now_ms() as u64);
    items.truncate(items.len().min(count.max(1)));
    items
}

fn parse_wander_json_payload(payload: &str) -> Option<Value> {
    let trimmed = payload.trim();
    if trimmed.is_empty() {
        return None;
    }
    let strip_code_fence = |text: &str| {
        text.trim()
            .trim_start_matches("```json")
            .trim_start_matches("```")
            .trim_end_matches("```")
            .trim()
            .to_string()
    };
    let try_parse = |text: &str| serde_json::from_str::<Value>(text).ok();
    if let Some(value) = try_parse(trimmed) {
        return Some(value);
    }
    let without_fence = strip_code_fence(trimmed);
    if let Some(value) = try_parse(&without_fence) {
        return Some(value);
    }
    let first_brace = without_fence.find('{')?;
    let last_brace = without_fence.rfind('}')?;
    if last_brace <= first_brace {
        return None;
    }
    try_parse(&without_fence[first_brace..=last_brace])
}

fn normalize_wander_connections(raw: Option<&Value>) -> Vec<Value> {
    let Some(items) = raw.and_then(Value::as_array) else {
        return vec![json!(1)];
    };
    let mut normalized = Vec::<i64>::new();
    for item in items {
        let Some(value) = item
            .as_i64()
            .or_else(|| item.as_u64().map(|v| v as i64))
            .or_else(|| {
                item.as_str()
                    .and_then(|text| text.trim().parse::<i64>().ok())
            })
        else {
            continue;
        };
        let bounded = value.clamp(1, 3);
        if !normalized.contains(&bounded) {
            normalized.push(bounded);
        }
    }
    if normalized.is_empty() {
        normalized.push(1);
    }
    normalized.into_iter().map(Value::from).collect()
}

fn normalize_wander_option(raw: &Value) -> Value {
    let topic = raw.get("topic").and_then(Value::as_object);
    let title = topic
        .and_then(|value| value.get("title"))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            raw.get("title")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
        })
        .unwrap_or("未命名选题")
        .trim()
        .to_string();
    let content_direction = raw
        .get("content_direction")
        .and_then(Value::as_str)
        .or_else(|| raw.get("direction").and_then(Value::as_str))
        .or_else(|| raw.get("contentDirection").and_then(Value::as_str))
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("围绕素材提炼一个可执行的内容方向。")
        .trim()
        .to_string();
    json!({
        "content_direction": content_direction,
        "topic": {
            "title": title,
            "connections": normalize_wander_connections(
                topic.and_then(|value| value.get("connections")).or_else(|| raw.get("connections"))
            )
        }
    })
}

fn repair_embedded_wander_result(raw: Value) -> Value {
    let Some(content_direction) = raw.get("content_direction").and_then(Value::as_str) else {
        return raw;
    };
    let Some(embedded) = parse_wander_json_payload(content_direction) else {
        return raw;
    };
    if embedded.get("topic").is_none() {
        return raw;
    }
    let merged_thinking = raw
        .get("thinking_process")
        .cloned()
        .filter(|value| {
            value
                .as_array()
                .map(|items| !items.is_empty())
                .unwrap_or(false)
        })
        .or_else(|| embedded.get("thinking_process").cloned())
        .unwrap_or_else(|| json!([]));
    json!({
        "content_direction": embedded.get("content_direction").cloned().or_else(|| raw.get("content_direction").cloned()).unwrap_or_else(|| json!("")),
        "thinking_process": merged_thinking,
        "topic": embedded.get("topic").cloned().or_else(|| raw.get("topic").cloned()).unwrap_or_else(|| json!({
            "title": "未命名选题",
            "connections": [1]
        })),
        "options": raw.get("options").cloned().or_else(|| embedded.get("options").cloned()),
        "selected_index": raw.get("selected_index").cloned().or_else(|| embedded.get("selected_index").cloned()).unwrap_or_else(|| json!(0))
    })
}

fn normalize_wander_result(raw: Value, multi_choice: bool) -> Value {
    let repaired = repair_embedded_wander_result(raw);
    let thinking_process = repaired
        .get("thinking_process")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str())
                .map(|item| item.trim())
                .filter(|item| !item.is_empty())
                .take(6)
                .map(|item| Value::from(item.to_string()))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    if multi_choice {
        let candidate_options = repaired
            .get("options")
            .and_then(Value::as_array)
            .cloned()
            .or_else(|| repaired.get("choices").and_then(Value::as_array).cloned())
            .unwrap_or_default();
        let mut normalized_options = candidate_options
            .iter()
            .map(normalize_wander_option)
            .collect::<Vec<_>>();
        if normalized_options.is_empty() {
            normalized_options.push(normalize_wander_option(&repaired));
        }
        while normalized_options.len() < 3 {
            let fallback = normalized_options
                .last()
                .cloned()
                .unwrap_or_else(|| normalize_wander_option(&repaired));
            normalized_options.push(fallback);
        }
        normalized_options.truncate(3);
        let first = normalized_options
            .first()
            .cloned()
            .unwrap_or_else(|| normalize_wander_option(&repaired));
        return json!({
            "thinking_process": thinking_process,
            "options": normalized_options,
            "content_direction": first.get("content_direction").cloned().unwrap_or_else(|| json!("")),
            "topic": first.get("topic").cloned().unwrap_or_else(|| json!({
                "title": "未命名选题",
                "connections": [1]
            })),
            "selected_index": 0
        });
    }

    let single = normalize_wander_option(&repaired);
    json!({
        "content_direction": single.get("content_direction").cloned().unwrap_or_else(|| json!("")),
        "thinking_process": thinking_process,
        "topic": single.get("topic").cloned().unwrap_or_else(|| json!({
            "title": "未命名选题",
            "connections": [1]
        }))
    })
}

fn build_legacy_wander_prompt(
    items_text: &str,
    long_term_context_section: &str,
    materials_guide: &str,
    multi_choice: bool,
) -> String {
    let output_requirement = if multi_choice {
        [
            "硬性输出要求（多选题模式）：",
            "1) 仅输出 JSON，不要输出 Markdown、解释、前后缀文本；",
            "2) JSON 顶层必须包含：thinking_process, options；",
            "3) options 必须是长度为 3 的数组；",
            "4) 每个 option 必须包含：content_direction, topic；",
            "5) topic 必须包含：title, connections（数组，取值只能是 1-3）；",
            "6) thinking_process 为 3-6 条简洁思考要点。",
            "7) title 必须是可直接发布/继续创作的中文标题，不能是“从某素材延展出的内容选题”这类模板句。",
            "8) content_direction 必须具体说明面向谁、核心冲突是什么、切入角度是什么，不得使用空泛套话。",
        ]
        .join("\n")
    } else {
        [
            "硬性输出要求（单选题模式）：",
            "1) 仅输出 JSON，不要输出 Markdown、解释、前后缀文本；",
            "2) JSON 顶层必须包含：content_direction, thinking_process, topic；",
            "3) topic 必须包含：title, connections（数组，取值只能是 1-3）；",
            "4) thinking_process 为 3-6 条简洁思考要点；",
            "5) content_direction 必须是可直接创作的内容方向说明。",
            "6) topic.title 必须是可直接发布/继续创作的中文标题，不能是“从某素材延展出的内容选题”这类模板句。",
            "7) content_direction 必须明确：目标读者、核心矛盾、叙事角度、可用素材切入点；不得使用“围绕这组素材提炼一个方向”之类空话。",
        ]
        .join("\n")
    };

    [
        "你现在处于 RedBox 的「漫步深度思考」Agent 模式。",
        "你需要自主完成：分析素材 -> 发散选题 -> 收敛方向 -> 产出最终结构化结果。",
        "你必须先调用工具补充上下文，再给结论。",
        "",
        "工具调用要求（必须满足）：",
        "1) 至少发起 1 次工具调用；",
        "2) 优先读取素材目录、meta.json、正文或转录文件；",
        "3) 未发生工具调用时，不允许直接输出最终结论。",
        "",
        &output_requirement,
        "",
        "你收到的随机素材如下：",
        items_text,
        "",
        "你可读取的真实素材路径如下：",
        materials_guide,
        "",
        if long_term_context_section.is_empty() {
            ""
        } else {
            long_term_context_section
        },
    ]
    .join("\n")
}

fn build_wander_materials_guide(items: &[Value]) -> String {
    items
        .iter()
        .enumerate()
        .map(|(index, item)| {
            let title = item
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or("Untitled");
            let item_type = item.get("type").and_then(Value::as_str).unwrap_or("note");
            let meta = item
                .get("meta")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            let source_type = meta
                .get("sourceType")
                .and_then(Value::as_str)
                .unwrap_or("");
            if source_type == "document" {
                let root_path = meta
                    .get("filePath")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .trim()
                    .to_string();
                let relative_path = meta
                    .get("relativePath")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .trim()
                    .to_string();
                return format!(
                    "素材 {} | 标题: {}\n- 类型: {}\n- sourceType: {}\n- 用 redbox_fs 直接读取文件: {}\n- 如果需要更多上下文，优先读取该文档本身，不要泛泛总结。",
                    index + 1,
                    title,
                    item_type,
                    source_type,
                    if !relative_path.is_empty() { relative_path } else { root_path }
                );
            }

            let folder_path = meta
                .get("folderPath")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_string();
            let read_hint = if source_type == "youtube" || item_type == "video" {
                "先 list 目录，再优先读取 meta.json；若 meta 中存在 transcriptFile / subtitle 线索，再读取对应转录文件。"
            } else {
                "先 list 目录，再优先读取 meta.json；如果目录中存在 content.md，再继续读取 content.md。"
            };
            format!(
                "素材 {} | 标题: {}\n- 类型: {}\n- sourceType: {}\n- 目录路径: {}\n- 读取顺序: {}",
                index + 1,
                title,
                item_type,
                source_type,
                folder_path,
                read_hint
            )
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

fn wander_result_has_placeholder_text(result: &Value) -> bool {
    let generic_title_markers = ["延展出的内容选题", "未命名选题"];
    let generic_direction_markers = [
        "围绕这组素材提炼",
        "围绕素材提炼一个可执行的内容方向",
        "围绕素材提炼一个更聚焦",
    ];

    let has_generic_title = |title: &str| {
        let normalized = title.trim();
        normalized.is_empty()
            || generic_title_markers
                .iter()
                .any(|marker| normalized.contains(marker))
    };
    let has_generic_direction = |direction: &str| {
        let normalized = direction.trim();
        normalized.is_empty()
            || generic_direction_markers
                .iter()
                .any(|marker| normalized.contains(marker))
    };

    if let Some(options) = result.get("options").and_then(Value::as_array) {
        return options.iter().any(|option| {
            let title = option
                .get("topic")
                .and_then(|value| value.get("title"))
                .and_then(Value::as_str)
                .unwrap_or("");
            let direction = option
                .get("content_direction")
                .and_then(Value::as_str)
                .unwrap_or("");
            has_generic_title(title) || has_generic_direction(direction)
        });
    }

    let title = result
        .get("topic")
        .and_then(|value| value.get("title"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let direction = result
        .get("content_direction")
        .and_then(Value::as_str)
        .unwrap_or("");
    has_generic_title(title) || has_generic_direction(direction)
}

fn parse_wander_brainstorm_payload(payload: &Value) -> (Vec<Value>, Value) {
    if let Some(items) = payload_field(payload, "items").and_then(Value::as_array) {
        let options = payload_field(payload, "options")
            .cloned()
            .unwrap_or_else(|| json!({}));
        return (items.clone(), options);
    }

    if let Some(array_payload) = payload.as_array() {
        let nested_items = array_payload
            .first()
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let options = array_payload.get(1).cloned().unwrap_or_else(|| json!({}));
        if !nested_items.is_empty() || array_payload.len() > 1 {
            return (nested_items, options);
        }
        return (array_payload.clone(), json!({}));
    }

    (Vec::new(), json!({}))
}

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
            | "chat:list-context-sessions"
            | "chat:create-context-session"
            | "chat:create-diagnostics-session"
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
                let initial_context = payload_string(&payload, "initialContext");
                let session = with_store_mut(state, |store| {
                    Ok(ensure_context_session(
                        store,
                        &context_type,
                        &context_id,
                        title,
                        initial_context.as_deref(),
                    ))
                })?;
                Ok(json!(session))
            }
            "chat:list-context-sessions" => {
                let context_id = payload_string(&payload, "contextId").unwrap_or_default();
                let context_type = payload_string(&payload, "contextType").unwrap_or_default();
                with_store(state, |store| {
                    let items = list_context_sessions(&store, &context_type, &context_id);
                    Ok(json!(items
                        .iter()
                        .map(|session| {
                            let transcript_meta = transcript_session_meta_by_id(state, &session.id)
                                .ok()
                                .flatten();
                            session_list_item_value(&store, session, transcript_meta.as_ref())
                        })
                        .collect::<Vec<_>>()))
                })
            }
            "chat:create-context-session" => {
                let context_id = payload_string(&payload, "contextId")
                    .unwrap_or_else(|| make_id("context").to_string());
                let context_type = payload_string(&payload, "contextType")
                    .unwrap_or_else(|| "context".to_string());
                let title =
                    payload_string(&payload, "title").unwrap_or_else(|| "New Chat".to_string());
                let initial_context = payload_string(&payload, "initialContext");
                let session = with_store_mut(state, |store| {
                    Ok(create_context_session(
                        store,
                        &context_type,
                        &context_id,
                        title,
                        initial_context.as_deref(),
                    ))
                })?;
                Ok(json!(session))
            }
            "chat:create-diagnostics-session" => {
                let (default_context_type, default_context_id, default_title) =
                    diagnostics_session_defaults();
                let context_type =
                    payload_string(&payload, "contextType").unwrap_or(default_context_type);
                let context_id =
                    payload_string(&payload, "contextId").unwrap_or(default_context_id);
                let title = payload_string(&payload, "title").unwrap_or(default_title);
                let session = with_store_mut(state, |store| {
                    Ok(ensure_context_session(
                        store,
                        &context_type,
                        &context_id,
                        title,
                        None,
                    ))
                })?;
                Ok(json!(session))
            }
            "chat:get-sessions" => with_store(state, |store| Ok(json!(list_sessions(&store)))),
            "sessions:list" => with_store(state, |store| {
                let started_at = now_ms();
                let request_id = format!("sessions:list:{}", started_at);
                let transcript_items = transcript_session_list_value(state)
                    .and_then(|value| {
                        value
                            .as_array()
                            .cloned()
                            .ok_or_else(|| "invalid transcript index".to_string())
                    })
                    .unwrap_or_default();
                let items: Vec<Value> = if transcript_items.is_empty() {
                    list_sessions(&store)
                        .into_iter()
                        .map(|session| {
                            let transcript_meta = transcript_session_meta_by_id(state, &session.id)
                                .ok()
                                .flatten();
                            session_list_item_value(&store, &session, transcript_meta.as_ref())
                        })
                        .collect()
                } else {
                    let mut merged = transcript_items;
                    let known_ids = merged
                        .iter()
                        .filter_map(|item| item.get("id").and_then(Value::as_str))
                        .map(ToString::to_string)
                        .collect::<std::collections::HashSet<_>>();
                    let mut store_only = store
                        .chat_sessions
                        .iter()
                        .filter(|session| !known_ids.contains(&session.id))
                        .map(|session| {
                            let transcript_meta = transcript_session_meta_by_id(state, &session.id)
                                .ok()
                                .flatten();
                            session_list_item_value(&store, session, transcript_meta.as_ref())
                        })
                        .collect::<Vec<_>>();
                    merged.append(&mut store_only);
                    merged.sort_by(|a, b| {
                        let left = a
                            .get("chatSession")
                            .and_then(|item| item.get("updatedAt"))
                            .and_then(Value::as_str)
                            .unwrap_or("");
                        let right = b
                            .get("chatSession")
                            .and_then(|item| item.get("updatedAt"))
                            .and_then(Value::as_str)
                            .unwrap_or("");
                        right.cmp(left)
                    });
                    merged
                };
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
                let requested_session_id = payload_string(&payload, "sessionId");
                with_store(state, |store| {
                    let Some(session_id) =
                        resolve_resume_target_session_id(&store, requested_session_id.as_deref())
                    else {
                        return Ok(Value::Null);
                    };
                    let transcript_meta = transcript_session_meta_by_id(state, &session_id)
                        .ok()
                        .flatten();
                    Ok(session_detail_value(
                        &store,
                        &session_id,
                        transcript_meta.as_ref(),
                    ))
                })
            }
            "sessions:resume" => with_store(state, |store| {
                let requested_session_id = payload_string(&payload, "sessionId");
                let Some(session_id) =
                    resolve_resume_target_session_id(&store, requested_session_id.as_deref())
                else {
                    return Ok(Value::Null);
                };
                let transcript_meta = transcript_session_meta_by_id(state, &session_id)
                    .ok()
                    .flatten();
                let resume_messages = transcript_resume_messages(
                    state,
                    &store,
                    &session_id,
                    crate::runtime::SESSION_CONTEXT_TAIL_MESSAGES,
                )
                .ok();
                let value = session_resume_value(
                    &store,
                    &session_id,
                    transcript_meta.as_ref(),
                    resume_messages.clone(),
                );
                if !value.is_null() {
                    return Ok(value);
                }
                Ok(json!({
                    "chatSession": transcript_meta.as_ref().map(|meta| json!({
                        "id": meta.session_id,
                        "title": meta.title,
                        "updatedAt": meta.updated_at,
                        "createdAt": meta.created_at,
                    })).unwrap_or(Value::Null),
                    "summary": transcript_meta.as_ref().map(|meta| meta.summary.clone()).unwrap_or_default(),
                    "messageCount": transcript_meta.as_ref().map(|meta| meta.message_count).unwrap_or(0),
                    "context": Value::Null,
                    "resumeMessages": resume_messages.unwrap_or_default(),
                    "lastCheckpoint": Value::Null,
                }))
            }),
            "sessions:fork" => {
                let session_id = payload_string(&payload, "sessionId").unwrap_or_default();
                let forked = with_store_mut(state, |store| {
                    let Some(forked) = fork_session(store, &session_id) else {
                        return Ok(json!({ "success": false, "error": "会话不存在" }));
                    };
                    Ok(json!({
                        "success": true,
                        "session": {
                            "id": forked.session.id,
                            "transcriptCount": forked.transcript_count,
                            "checkpointCount": forked.checkpoint_count,
                        }
                    }))
                })?;
                if let Some(new_id) = forked
                    .get("session")
                    .and_then(|item| item.get("id"))
                    .and_then(Value::as_str)
                {
                    let _ = crate::runtime::duplicate_session_bundle(state, &session_id, new_id);
                }
                Ok(forked)
            }
            "sessions:get-transcript" => {
                let requested_session_id = payload_string(&payload, "sessionId");
                with_store(state, |store| {
                    let Some(session_id) =
                        resolve_resume_target_session_id(&store, requested_session_id.as_deref())
                    else {
                        return Ok(json!([]));
                    };
                    Ok(json!(trace_for_session(&store, &session_id)))
                })
            }
            "sessions:get-tool-results" => {
                let requested_session_id = payload_string(&payload, "sessionId");
                with_store(state, |store| {
                    let Some(session_id) =
                        resolve_resume_target_session_id(&store, requested_session_id.as_deref())
                    else {
                        return Ok(json!([]));
                    };
                    Ok(json!(tool_results_for_session(&store, &session_id)))
                })
            }
            "chat:get-messages" => {
                let requested_session_id = payload_value_as_string(&payload);
                with_store(state, |store| {
                    let Some(session_id) =
                        resolve_resume_target_session_id(&store, requested_session_id.as_deref())
                    else {
                        return Ok(json!([]));
                    };
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
                let session =
                    with_store_mut(state, |store| Ok(create_session(store, title, None)))?;
                Ok(json!(session))
            }
            "chat:delete-session" => {
                let session_id = payload_value_as_string(&payload).unwrap_or_default();
                with_store_mut(state, |store| {
                    let _ = delete_session(store, &session_id);
                    Ok(json!({ "success": true }))
                })?;
                let _ = crate::runtime::remove_session_bundle(state, &session_id);
                Ok(json!({ "success": true }))
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
                    store
                        .session_context_records
                        .retain(|item| item.session_id != session_id);
                    Ok(json!({ "success": true }))
                })?;
                if let Ok(mut guard) = state.chat_runtime_states.lock() {
                    guard.remove(&session_id);
                }
                let _ = crate::runtime::remove_session_bundle(state, &session_id);
                Ok(json!({ "success": true }))
            }
            "chat:compact-context" => {
                let session_id = payload_value_as_string(&payload).unwrap_or_default();
                let result = with_store_mut(state, |store| {
                    let total_messages =
                        crate::runtime::session_message_count_for_session(store, &session_id);
                    let snapshot =
                        update_session_context_record(store, &session_id, "manual", true);
                    Ok(match snapshot {
                        Some(record) => json!({
                            "success": true,
                            "compacted": true,
                            "message": format!(
                                "已归档 {} 条历史消息，保留最近 {} 条用于继续对话",
                                record.compacted_message_count,
                                record.tail_message_count
                            ),
                            "context": crate::runtime::session_context_value_for_session(store, &session_id),
                            "usage": crate::runtime::session_context_usage_value(store, &session_id),
                            "totalMessages": total_messages,
                        }),
                        None => json!({
                            "success": true,
                            "compacted": false,
                            "message": if total_messages <= crate::runtime::SESSION_CONTEXT_TAIL_MESSAGES as i64 {
                                format!(
                                    "当前仅有 {} 条消息，至少需要超过 {} 条消息才有可归档内容",
                                    total_messages,
                                    crate::runtime::SESSION_CONTEXT_TAIL_MESSAGES
                                )
                            } else {
                                let usage = crate::runtime::session_context_usage_value(store, &session_id);
                                let threshold = usage
                                    .get("compactThreshold")
                                    .and_then(Value::as_i64)
                                    .unwrap_or(crate::runtime::DEFAULT_SESSION_COMPACT_TARGET_TOKENS);
                                let effective = usage
                                    .get("estimatedEffectiveTokens")
                                    .and_then(Value::as_i64)
                                    .unwrap_or(0);
                                format!(
                                    "当前有效上下文约 {} tokens，尚未超过自动 compact 阈值 {}，且没有新的可归档历史",
                                    effective,
                                    threshold
                                )
                            }
                        }),
                    })
                })?;
                if result
                    .get("compacted")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
                {
                    let summary = result
                        .get("context")
                        .and_then(|value| value.get("summary"))
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    let _ = with_store(state, |store| {
                        append_compact_boundary_entry(state, &store, &session_id, summary)
                    });
                }
                Ok(result)
            }
            "chat:get-context-usage" => {
                let session_id = payload_value_as_string(&payload).unwrap_or_default();
                with_store(state, |store| {
                    Ok(session_context_usage_value(&store, &session_id))
                })
            }
            "chat:update-session-metadata" => {
                let session_id = payload_string(&payload, "sessionId").unwrap_or_default();
                let metadata = payload_field(&payload, "metadata").cloned();
                with_store_mut(state, |store| {
                    let _ = update_metadata(store, &session_id, metadata);
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
                Ok(json!(pick_random_wander_items(
                    collect_wander_candidate_items(&store),
                    3,
                )))
            }),
            "wander:brainstorm" => {
                let request_started_at = now_ms();
                let (mut items, options) = parse_wander_brainstorm_payload(&payload);
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
                    items = with_store(state, |store| {
                        Ok(pick_random_wander_items(
                            collect_wander_candidate_items(&store),
                            3,
                        ))
                    })?;
                }
                if items.is_empty() {
                    return Ok(json!({
                        "error": "暂无足够内容，请先收集一些笔记、视频或文档。",
                        "result": Value::Null,
                        "historyId": Value::Null,
                        "items": []
                    }));
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
                let multi_choice = payload_field(&options, "multiChoice")
                    .and_then(|value| value.as_bool())
                    .unwrap_or(false);
                let wander_session_id =
                    format!("session_wander_{}", slug_from_relative_path(&request_id));
                let _ = app.emit(
                    "wander:progress",
                    json!({
                        "requestId": request_id.clone(),
                        "sessionId": wander_session_id.clone(),
                        "phase": "collect",
                        "stepIndex": 1,
                        "totalSteps": 3,
                        "title": "选择随机素材",
                        "status": "completed",
                        "detail": format!("已装载 {} 条随机素材。", items.len()),
                    }),
                );
                let _ = app.emit(
                    "wander:progress",
                    json!({
                        "requestId": request_id.clone(),
                        "sessionId": wander_session_id.clone(),
                        "phase": "context",
                        "stepIndex": 2,
                        "totalSteps": 3,
                        "title": "构建上下文",
                        "status": "running",
                        "detail": "正在加载用户档案与长期记忆...",
                    }),
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
                let _ = app.emit(
                    "wander:progress",
                    json!({
                        "requestId": request_id.clone(),
                        "sessionId": wander_session_id.clone(),
                        "phase": "context",
                        "stepIndex": 2,
                        "totalSteps": 3,
                        "title": "构建上下文",
                        "status": "completed",
                        "detail": "长期上下文已准备完成，Agent 将自行读取关键素材文件。",
                    }),
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
                let materials_guide = build_wander_materials_guide(&items);
                let prompt = build_legacy_wander_prompt(
                    &items_text,
                    &long_term_context_section,
                    &materials_guide,
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
                with_store_mut(state, |store| {
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
                        "activeSkills": ["writing-style"],
                    }));
                    session.updated_at = now_iso();
                    Ok(())
                })?;
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
                        "requestId": request_id.clone(),
                        "sessionId": wander_session_id.clone(),
                        "phase": "generate",
                        "stepIndex": 3,
                        "totalSteps": 3,
                        "title": "生成选题",
                        "status": "running",
                        "detail": "正在启动漫步 Agent，并基于已读取的关键素材生成最终选题。",
                    }),
                );
                let execution_started_at = now_ms();
                let model_result = generate_wander_response(
                    app,
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
                .map_err(|error| {
                    append_debug_log_state(
                        state,
                        format!(
                            "[runtime][wander][{}] wander-runtime-failed | {}",
                            wander_session_id, error
                        ),
                    );
                    error
                })?;
                log_timing_event(
                    state,
                    "wander",
                    &request_id,
                    "execution-finished",
                    execution_started_at,
                    Some(format!("responseChars={}", model_result.chars().count())),
                );
                let parse_started_at = now_ms();
                let parsed_payload = parse_wander_json_payload(&model_result)
                    .unwrap_or_else(|| json!({ "content_direction": model_result.clone() }));
                let result_value = normalize_wander_result(parsed_payload, multi_choice);
                if wander_result_has_placeholder_text(&result_value) {
                    return Err("漫步结果过于空泛：标题或内容方向仍是模板化占位表达".to_string());
                }
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
                        Some(json!({ "responsePreview": text_snippet(&result_text, 160) })),
                    );
                    store.wander_history.push(WanderHistoryRecord {
                        id: history_id.clone(),
                        items: serde_json::to_string(&items).map_err(|error| error.to_string())?,
                        result: result_text.clone(),
                        created_at: now_i64(),
                    });
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
                        "requestId": request_id.clone(),
                        "sessionId": wander_session_id.clone(),
                        "phase": "complete",
                        "stepIndex": 3,
                        "totalSteps": 3,
                        "title": "保存结果",
                        "status": "completed",
                        "detail": "漫步完成，结果已写入历史记录。",
                    }),
                );
                log_timing_event(
                    state,
                    "wander",
                    &request_id,
                    "request-complete",
                    request_started_at,
                    Some(format!("sessionId={}", wander_session_id)),
                );
                Ok(json!({ "result": result_text, "historyId": history_id, "items": items }))
            }
            _ => Err(format!(
                "RedBox host does not recognize channel `{channel}`."
            )),
        }
    })())
}
