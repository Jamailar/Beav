use crate::persistence::{
    apply_chatrooms_hydration_snapshot, load_chatrooms_hydration_snapshot, with_store,
    with_store_mut,
};
use crate::runtime::tool_results_for_session;
use crate::*;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, State};

use crate::commands::runtime_query::handle_runtime_query;
use crate::events::emit_creative_chat_checkpoint;
use crate::session_manager::ensure_context_session;
use std::fs;
use std::path::PathBuf;

const SIX_HATS_ROOM_ID: &str = "system_six_thinking_hats";
const SIX_HATS_ROOM_NAME: &str = "六顶思考帽";
const SYSTEM_ROOMS_STATE_FILE: &str = ".system_rooms_state.json";
const CHATROOM_ADVISOR_CONTEXT_TYPE: &str = "chatroom-advisor";
const CHATROOM_HISTORY_LIMIT: usize = 10;
const CHATROOM_MESSAGE_MAX_CHARS: usize = 1200;
const CHATROOM_CONTEXT_MAX_CHARS: usize = 6000;
const CHATROOM_TOOL_SUMMARY_CHARS: usize = 240;
const CHATROOM_SOURCE_LIMIT: usize = 8;
const SIX_THINKING_HAT_IDS: [&str; 6] = [
    "hat_white",
    "hat_red",
    "hat_black",
    "hat_yellow",
    "hat_green",
    "hat_blue",
];

fn chatrooms_root(state: &State<'_, AppState>) -> Result<PathBuf, String> {
    let root = workspace_root(state)?.join("chatrooms");
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    Ok(root)
}

fn chatroom_file_path(state: &State<'_, AppState>, room_id: &str) -> Result<PathBuf, String> {
    Ok(chatrooms_root(state)?.join(format!("{room_id}.json")))
}

fn persist_chatroom_from_store(
    state: &State<'_, AppState>,
    store: &AppStore,
    room_id: &str,
) -> Result<(), String> {
    let Some(room) = store.chat_rooms.iter().find(|item| item.id == room_id) else {
        return Ok(());
    };
    let messages = store
        .chatroom_messages
        .iter()
        .filter(|item| item.room_id == room_id)
        .cloned()
        .collect::<Vec<_>>();
    let payload = json!({
        "id": room.id,
        "name": room.name,
        "advisorIds": room.advisor_ids,
        "messages": messages.iter().map(|item| json!({
            "id": item.id,
            "role": item.role,
            "advisorId": item.advisor_id,
            "advisorName": item.advisor_name,
            "advisorAvatar": item.advisor_avatar,
            "content": item.content,
            "timestamp": item.timestamp,
            "isStreaming": item.is_streaming,
            "phase": item.phase,
        })).collect::<Vec<_>>(),
        "createdAt": room.created_at,
        "isSystem": room.is_system,
        "systemType": room.system_type,
    });
    let path = chatroom_file_path(state, room_id)?;
    fs::write(
        path,
        serde_json::to_string_pretty(&payload).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())
}

fn append_chatroom_message_to_file(
    state: &State<'_, AppState>,
    room: &ChatRoomRecord,
    message: &ChatRoomMessageRecord,
) -> Result<(), String> {
    let path = chatroom_file_path(state, &room.id)?;
    let mut payload = if path.exists() {
        fs::read_to_string(&path)
            .ok()
            .and_then(|content| serde_json::from_str::<Value>(&content).ok())
            .unwrap_or_else(|| json!({}))
    } else {
        json!({})
    };
    let object = payload
        .as_object_mut()
        .ok_or_else(|| "chatroom file payload should be object".to_string())?;
    object.insert("id".to_string(), json!(room.id));
    object.insert("name".to_string(), json!(room.name));
    object.insert("advisorIds".to_string(), json!(room.advisor_ids));
    object.insert("createdAt".to_string(), json!(room.created_at));
    object.insert("isSystem".to_string(), json!(room.is_system));
    object.insert("systemType".to_string(), json!(room.system_type));
    let messages = object
        .entry("messages".to_string())
        .or_insert_with(|| json!([]));
    let items = messages
        .as_array_mut()
        .ok_or_else(|| "chatroom messages should be array".to_string())?;
    items.push(json!({
        "id": message.id,
        "role": message.role,
        "advisorId": message.advisor_id,
        "advisorName": message.advisor_name,
        "advisorAvatar": message.advisor_avatar,
        "content": message.content,
        "timestamp": message.timestamp,
        "isStreaming": message.is_streaming,
        "phase": message.phase,
    }));
    fs::write(
        path,
        serde_json::to_string_pretty(&payload).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())
}

fn remove_chatroom_file(state: &State<'_, AppState>, room_id: &str) -> Result<(), String> {
    let path = chatroom_file_path(state, room_id)?;
    if path.exists() {
        fs::remove_file(path).map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn ensure_six_hats_room(state: &State<'_, AppState>) -> Result<(), String> {
    let root = chatrooms_root(state)?;
    let state_path = root.join(SYSTEM_ROOMS_STATE_FILE);
    let disabled = fs::read_to_string(&state_path)
        .ok()
        .and_then(|content| serde_json::from_str::<Value>(&content).ok())
        .and_then(|value| {
            value
                .get("disabledRoomIds")
                .and_then(|item| item.as_array())
                .cloned()
        })
        .unwrap_or_default()
        .iter()
        .filter_map(|item| item.as_str())
        .any(|item| item == SIX_HATS_ROOM_ID);
    if disabled {
        return Ok(());
    }
    let room_path = root.join(format!("{SIX_HATS_ROOM_ID}.json"));
    if room_path.exists() {
        return Ok(());
    }
    let payload = json!({
        "id": SIX_HATS_ROOM_ID,
        "name": SIX_HATS_ROOM_NAME,
        "advisorIds": SIX_THINKING_HAT_IDS,
        "messages": [],
        "createdAt": now_iso(),
        "isSystem": true,
        "systemType": "six_thinking_hats",
    });
    fs::write(
        room_path,
        serde_json::to_string_pretty(&payload).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())
}

fn ensure_chatroom_advisor_runtime_session(
    state: &State<'_, AppState>,
    room: &ChatRoomRecord,
    advisor_id: &str,
    advisor_name: &str,
) -> Result<ChatSessionRecord, String> {
    let binding_id = format!("{}:{}", room.id, advisor_id);
    let title = format!("{} · {}", room.name, advisor_name);
    with_store_mut(state, |store| {
        let session = ensure_context_session(
            store,
            CHATROOM_ADVISOR_CONTEXT_TYPE,
            &binding_id,
            title,
            None,
        );
        let Some(existing) = store
            .chat_sessions
            .iter_mut()
            .find(|item| item.id == session.id)
        else {
            return Ok(session);
        };
        let mut metadata = existing
            .metadata
            .clone()
            .and_then(|value| value.as_object().cloned())
            .unwrap_or_default();
        metadata.insert(
            "contextType".to_string(),
            Value::String(CHATROOM_ADVISOR_CONTEXT_TYPE.to_string()),
        );
        metadata.insert("contextId".to_string(), Value::String(binding_id));
        metadata.insert("isContextBound".to_string(), Value::Bool(true));
        metadata.insert("roomId".to_string(), Value::String(room.id.clone()));
        metadata.insert("roomName".to_string(), Value::String(room.name.clone()));
        metadata.insert(
            "advisorName".to_string(),
            Value::String(advisor_name.to_string()),
        );
        metadata.insert("advisorIds".to_string(), json!([advisor_id]));
        if advisor_id != "director-system" {
            metadata.insert(
                "advisorId".to_string(),
                Value::String(advisor_id.to_string()),
            );
        } else {
            metadata.remove("advisorId");
        }
        existing.metadata = Some(Value::Object(metadata));
        existing.updated_at = now_iso();
        Ok(existing.clone())
    })
}

fn truncate_chars(value: &str, max_chars: usize) -> String {
    let chars = value.chars().collect::<Vec<_>>();
    if chars.len() <= max_chars {
        return value.to_string();
    }
    chars.into_iter().take(max_chars).collect::<String>()
}

fn chatroom_message_author_label(
    message: &ChatRoomMessageRecord,
    advisors: &[AdvisorRecord],
) -> String {
    if message.role == "user" {
        return "用户".to_string();
    }
    if let Some(name) = message
        .advisor_name
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        return name.to_string();
    }
    if let Some(advisor_id) = message.advisor_id.as_deref() {
        if advisor_id == "director-system" {
            return "总监".to_string();
        }
        return find_advisor_name(advisors, advisor_id);
    }
    "成员".to_string()
}

fn build_chatroom_runtime_message(
    room: &ChatRoomRecord,
    advisor_name: &str,
    room_history: &[ChatRoomMessageRecord],
    user_message: &str,
    context: Option<&Value>,
    advisors: &[AdvisorRecord],
) -> String {
    let history_block = room_history
        .iter()
        .rev()
        .take(CHATROOM_HISTORY_LIMIT)
        .cloned()
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .map(|item| {
            format!(
                "- [{}] {}",
                chatroom_message_author_label(&item, advisors),
                truncate_chars(&item.content, CHATROOM_MESSAGE_MAX_CHARS)
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    let context_block = context
        .map(|value| serde_json::to_string_pretty(value).unwrap_or_else(|_| value.to_string()))
        .map(|value| truncate_chars(&value, CHATROOM_CONTEXT_MAX_CHARS))
        .filter(|value| !value.trim().is_empty())
        .map(|value| format!("\n\n附加上下文：\n{value}"))
        .unwrap_or_default();
    format!(
        "你正在群聊房间《{}》中以成员“{}”的身份参与讨论。\n\
先结合最近群聊内容理解问题，再给出你的发言；如果需要确认该成员自己的资料、规则、案例或笔记，优先使用 knowledge_glob / knowledge_grep / knowledge_read 在该成员知识库中检索，不要假装已经知道。\n\n\
最近群聊：\n{}\n\n\
当前用户消息：\n{}{}",
        room.name,
        advisor_name,
        if history_block.trim().is_empty() {
            "- 暂无历史对话".to_string()
        } else {
            history_block
        },
        user_message,
        context_block
    )
}

fn collect_runtime_tool_results_after(
    state: &State<'_, AppState>,
    session_id: &str,
    previous_count: usize,
) -> Result<Vec<crate::runtime::SessionToolResultRecord>, String> {
    with_store(state, |store| {
        let items = tool_results_for_session(&store, session_id)
            .into_iter()
            .skip(previous_count)
            .collect::<Vec<_>>();
        Ok(items)
    })
}

fn summarize_tool_result(item: &crate::runtime::SessionToolResultRecord) -> String {
    item.summary_text
        .clone()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| item.result_text.clone())
        .map(|value| truncate_chars(&value, CHATROOM_TOOL_SUMMARY_CHARS))
        .unwrap_or_else(|| {
            if item.success {
                format!("{} succeeded", item.tool_name)
            } else {
                format!("{} failed", item.tool_name)
            }
        })
}

fn knowledge_sources_from_tool_payload(payload: Option<&Value>, sources: &mut Vec<String>) {
    let Some(payload) = payload else {
        return;
    };
    if let Some(path) = payload.get("path").and_then(Value::as_str) {
        if !path.trim().is_empty() {
            sources.push(path.to_string());
        }
    }
    if let Some(files) = payload.get("files").and_then(Value::as_array) {
        for file in files.iter().take(CHATROOM_SOURCE_LIMIT) {
            if let Some(path) = file.get("path").and_then(Value::as_str) {
                if !path.trim().is_empty() {
                    sources.push(path.to_string());
                }
            }
        }
    }
    if let Some(hits) = payload.get("hits").and_then(Value::as_array) {
        for hit in hits.iter().take(CHATROOM_SOURCE_LIMIT) {
            if let Some(path) = hit.get("path").and_then(Value::as_str) {
                if !path.trim().is_empty() {
                    sources.push(path.to_string());
                }
            }
        }
    }
}

fn emit_chatroom_runtime_tool_summaries(
    app: &AppHandle,
    room_id: &str,
    advisor_id: &str,
    tool_results: &[crate::runtime::SessionToolResultRecord],
) {
    let mut knowledge_sources = Vec::<String>::new();
    let mut used_knowledge_tools = false;
    for item in tool_results {
        emit_creative_chat_checkpoint(
            app,
            room_id,
            "creative_chat.tool",
            json!({
                "roomId": room_id,
                "advisorId": advisor_id,
                "type": "tool_start",
                "tool": {
                    "name": item.tool_name,
                }
            }),
        );
        emit_creative_chat_checkpoint(
            app,
            room_id,
            "creative_chat.tool",
            json!({
                "roomId": room_id,
                "advisorId": advisor_id,
                "type": "tool_end",
                "tool": {
                    "name": item.tool_name,
                    "result": {
                        "success": item.success,
                        "content": summarize_tool_result(item)
                    }
                }
            }),
        );
        if item.tool_name.starts_with("knowledge_") {
            used_knowledge_tools = true;
            knowledge_sources_from_tool_payload(item.payload.as_ref(), &mut knowledge_sources);
        }
    }
    if !used_knowledge_tools {
        return;
    }
    knowledge_sources.sort();
    knowledge_sources.dedup();
    knowledge_sources.truncate(CHATROOM_SOURCE_LIMIT);
    emit_creative_chat_checkpoint(
        app,
        room_id,
        "creative_chat.rag",
        json!({
            "roomId": room_id,
            "advisorId": advisor_id,
            "type": "rag_end",
            "content": if knowledge_sources.is_empty() {
                "已检索成员知识库".to_string()
            } else {
                format!("已检索成员知识库，命中 {} 个来源", knowledge_sources.len())
            },
            "sources": knowledge_sources
        }),
    );
}

fn clear_chatroom_cancel(state: &State<'_, AppState>, room_id: &str) {
    if let Ok(mut guard) = state.creative_chat_cancellations.lock() {
        guard.remove(room_id);
    }
}

fn request_chatroom_cancel(state: &State<'_, AppState>, room_id: &str) {
    if let Ok(mut guard) = state.creative_chat_cancellations.lock() {
        guard.insert(room_id.to_string());
    }
}

fn is_chatroom_cancelled(state: &State<'_, AppState>, room_id: &str) -> bool {
    state
        .creative_chat_cancellations
        .lock()
        .map(|guard| guard.contains(room_id))
        .unwrap_or(false)
}

pub fn handle_chatrooms_channel(
    app: &AppHandle,
    state: &State<'_, AppState>,
    channel: &str,
    payload: &Value,
) -> Option<Result<Value, String>> {
    if !matches!(
        channel,
        "chatrooms:list"
            | "chatrooms:messages"
            | "chatrooms:create"
            | "chatrooms:update"
            | "chatrooms:delete"
            | "chatrooms:clear"
            | "chatrooms:cancel"
            | "chatrooms:send"
    ) {
        return None;
    }

    Some((|| -> Result<Value, String> {
        match channel {
            "chatrooms:list" => {
                let _ = ensure_six_hats_room(state);
                if let Some(root) = with_store(state, |store| {
                    Ok(Some(active_space_workspace_root_from_store(
                        &store,
                        &store.active_space_id,
                        &state.store_path,
                    )?))
                })? {
                    let snapshot = load_chatrooms_hydration_snapshot(&root);
                    let _ = with_store_mut(state, |store| {
                        apply_chatrooms_hydration_snapshot(store, snapshot);
                        Ok(())
                    });
                }
                with_store(state, |store| {
                    let mut rooms = store.chat_rooms.clone();
                    rooms.sort_by(|a, b| {
                        b.is_system
                            .unwrap_or(false)
                            .cmp(&a.is_system.unwrap_or(false))
                            .then_with(|| b.created_at.cmp(&a.created_at))
                    });
                    Ok(json!(rooms))
                })
            }
            "chatrooms:messages" => {
                let room_id = payload_value_as_string(payload).unwrap_or_default();
                if let Some(root) = with_store(state, |store| {
                    Ok(Some(active_space_workspace_root_from_store(
                        &store,
                        &store.active_space_id,
                        &state.store_path,
                    )?))
                })? {
                    let snapshot = load_chatrooms_hydration_snapshot(&root);
                    let _ = with_store_mut(state, |store| {
                        apply_chatrooms_hydration_snapshot(store, snapshot);
                        Ok(())
                    });
                }
                with_store(state, |store| {
                    let mut items: Vec<ChatRoomMessageRecord> = store
                        .chatroom_messages
                        .iter()
                        .filter(|item| item.room_id == room_id)
                        .cloned()
                        .collect();
                    items.sort_by(|a, b| {
                        a.timestamp.cmp(&b.timestamp).then_with(|| a.id.cmp(&b.id))
                    });
                    Ok(json!(items))
                })
            }
            "chatrooms:create" => {
                let name =
                    payload_string(payload, "name").unwrap_or_else(|| "未命名群聊".to_string());
                let advisor_ids = payload_field(payload, "advisorIds")
                    .and_then(|value| value.as_array())
                    .map(|items| {
                        items
                            .iter()
                            .filter_map(|item| item.as_str().map(ToString::to_string))
                            .collect()
                    })
                    .unwrap_or_else(Vec::new);
                let room = with_store_mut(state, |store| {
                    let room = ChatRoomRecord {
                        id: make_id("chatroom"),
                        name,
                        advisor_ids,
                        created_at: now_iso(),
                        is_system: Some(false),
                        system_type: None,
                    };
                    store.chat_rooms.push(room.clone());
                    Ok(room)
                })?;
                with_store(state, |store| {
                    persist_chatroom_from_store(state, &store, &room.id)
                })?;
                Ok(json!(room))
            }
            "chatrooms:update" => {
                let room_id = payload_string(payload, "roomId").unwrap_or_default();
                let next_name = payload_string(payload, "name");
                let next_advisor_ids = payload_field(payload, "advisorIds")
                    .and_then(|value| value.as_array())
                    .map(|items| {
                        items
                            .iter()
                            .filter_map(|item| item.as_str().map(ToString::to_string))
                            .collect::<Vec<_>>()
                    });
                let result = with_store_mut(state, |store| {
                    let Some(room) = store.chat_rooms.iter_mut().find(|item| item.id == room_id)
                    else {
                        return Ok(json!({ "success": false, "error": "群聊不存在" }));
                    };
                    if let Some(name) = next_name.clone() {
                        room.name = name;
                    }
                    if let Some(advisor_ids) = next_advisor_ids.clone() {
                        room.advisor_ids = advisor_ids;
                    }
                    Ok(json!({ "success": true, "room": room.clone() }))
                })?;
                let _ = with_store(state, |store| {
                    persist_chatroom_from_store(state, &store, &room_id)
                });
                Ok(result)
            }
            "chatrooms:delete" => {
                let room_id = payload_value_as_string(payload).unwrap_or_default();
                let result = with_store_mut(state, |store| {
                    store.chat_rooms.retain(|item| item.id != room_id);
                    store
                        .chatroom_messages
                        .retain(|item| item.room_id != room_id);
                    Ok(json!({ "success": true }))
                })?;
                if room_id == SIX_HATS_ROOM_ID {
                    let root = chatrooms_root(state)?;
                    let state_path = root.join(SYSTEM_ROOMS_STATE_FILE);
                    let mut disabled_room_ids = fs::read_to_string(&state_path)
                        .ok()
                        .and_then(|content| serde_json::from_str::<Value>(&content).ok())
                        .and_then(|value| {
                            value
                                .get("disabledRoomIds")
                                .and_then(|item| item.as_array())
                                .cloned()
                        })
                        .unwrap_or_default()
                        .iter()
                        .filter_map(|item| item.as_str().map(ToString::to_string))
                        .collect::<Vec<_>>();
                    if !disabled_room_ids
                        .iter()
                        .any(|item| item == SIX_HATS_ROOM_ID)
                    {
                        disabled_room_ids.push(SIX_HATS_ROOM_ID.to_string());
                    }
                    let payload = json!({ "disabledRoomIds": disabled_room_ids });
                    fs::write(
                        state_path,
                        serde_json::to_string_pretty(&payload)
                            .map_err(|error| error.to_string())?,
                    )
                    .map_err(|error| error.to_string())?;
                }
                let _ = remove_chatroom_file(state, &room_id);
                Ok(result)
            }
            "chatrooms:clear" => {
                let room_id = payload_value_as_string(payload).unwrap_or_default();
                let result = with_store_mut(state, |store| {
                    store
                        .chatroom_messages
                        .retain(|item| item.room_id != room_id);
                    Ok(json!({ "success": true }))
                })?;
                let _ = with_store(state, |store| {
                    persist_chatroom_from_store(state, &store, &room_id)
                });
                Ok(result)
            }
            "chatrooms:cancel" => {
                let room_id = payload_string(payload, "roomId")
                    .or_else(|| payload_value_as_string(payload))
                    .unwrap_or_default();
                if room_id.trim().is_empty() {
                    return Ok(json!({ "success": false, "error": "缺少 roomId" }));
                }
                request_chatroom_cancel(state, &room_id);
                emit_creative_chat_checkpoint(
                    app,
                    &room_id,
                    "creative_chat.done",
                    json!({ "roomId": room_id, "cancelled": true }),
                );
                Ok(json!({ "success": true }))
            }
            "chatrooms:send" => {
                let room_id = payload_string(payload, "roomId").unwrap_or_default();
                let message = payload_string(payload, "message").unwrap_or_default();
                let client_message_id = payload_string(payload, "clientMessageId");
                let context = payload_field(payload, "context").cloned();
                let model_config = payload_field(payload, "modelConfig").cloned();
                if room_id.trim().is_empty() || message.trim().is_empty() {
                    return Ok(json!({ "success": false, "error": "缺少 roomId 或 message" }));
                }
                clear_chatroom_cancel(state, &room_id);
                eprintln!(
                    "[creative-chat][send] roomId={} messageChars={}",
                    room_id,
                    message.chars().count()
                );
                let settings_snapshot = with_store(state, |store| Ok(store.settings.clone()))?;
                let (room, advisors) = with_store(state, |store| {
                    let room = store
                        .chat_rooms
                        .iter()
                        .find(|item| item.id == room_id)
                        .cloned();
                    Ok((room, store.advisors.clone()))
                })?;
                let Some(room) = room else {
                    return Ok(json!({ "success": false, "error": "群聊不存在" }));
                };
                let user_message = ChatRoomMessageRecord {
                    id: client_message_id
                        .filter(|value| !value.trim().is_empty())
                        .unwrap_or_else(|| make_id("chatroom-message")),
                    room_id: room_id.clone(),
                    role: "user".to_string(),
                    advisor_id: None,
                    advisor_name: None,
                    advisor_avatar: None,
                    content: message.clone(),
                    timestamp: now_iso(),
                    is_streaming: Some(false),
                    phase: None,
                };
                append_chatroom_message_to_file(state, &room, &user_message)?;
                eprintln!("[creative-chat][user-persisted] roomId={}", room_id);
                emit_creative_chat_checkpoint(
                    app,
                    &room_id,
                    "creative_chat.user_message",
                    json!({ "roomId": room_id.clone(), "message": user_message }),
                );

                let target_advisor_ids = if room.advisor_ids.is_empty() {
                    vec!["director-system".to_string()]
                } else {
                    room.advisor_ids.clone()
                };
                let app_handle = app.clone();
                let room_id_for_task = room_id.clone();
                let message_for_task = message.clone();
                let context_for_task = context.clone();
                let model_config_for_task = model_config.clone();
                let advisors_for_task = advisors.clone();
                let target_advisor_ids_for_task = target_advisor_ids.clone();
                let room_history_for_task = with_store(state, |store| {
                    Ok(store
                        .chatroom_messages
                        .iter()
                        .filter(|item| item.room_id == room_id)
                        .cloned()
                        .collect::<Vec<_>>())
                })?;
                tauri::async_runtime::spawn(async move {
                    let managed_state = app_handle.state::<AppState>();
                    eprintln!(
                        "[creative-chat][spawned] roomId={} advisorCount={}",
                        room_id_for_task,
                        target_advisor_ids_for_task.len()
                    );
                    let mut rolling_history = room_history_for_task;
                    for (index, advisor_id) in target_advisor_ids_for_task.iter().enumerate() {
                        if is_chatroom_cancelled(&managed_state, &room_id_for_task) {
                            break;
                        }
                        eprintln!(
                            "[creative-chat][advisor-start] roomId={} advisorId={} index={}",
                            room_id_for_task, advisor_id, index
                        );
                        let advisor = advisors_for_task.iter().find(|item| item.id == *advisor_id);
                        let advisor_name = if advisor_id == "director-system" {
                            "总监".to_string()
                        } else {
                            find_advisor_name(&advisors_for_task, advisor_id)
                        };
                        let advisor_avatar = if advisor_id == "director-system" {
                            "🎯".to_string()
                        } else {
                            find_advisor_avatar(&advisors_for_task, advisor_id)
                        };
                        let phase =
                            chatroom_response_phase(index, target_advisor_ids_for_task.len());
                        emit_creative_chat_checkpoint(
                            &app_handle,
                            &room_id_for_task,
                            "creative_chat.advisor_start",
                            json!({
                                "roomId": room_id_for_task.clone(),
                                "advisorId": advisor_id,
                                "advisorName": advisor_name,
                                "advisorAvatar": advisor_avatar,
                                "phase": phase
                            }),
                        );
                        emit_creative_chat_checkpoint(
                            &app_handle,
                            &room_id_for_task,
                            "creative_chat.thinking",
                            json!({
                                "roomId": room_id_for_task.clone(),
                                "advisorId": advisor_id,
                                "type": "thinking_start",
                                "content": "正在分析群聊上下文并准备检索成员知识..."
                            }),
                        );
                        let response = if advisor_id == "director-system" {
                            let prompt = build_advisor_prompt(
                                advisor,
                                &message_for_task,
                                context_for_task.as_ref(),
                            );
                            generate_response_with_settings(
                                &settings_snapshot,
                                model_config_for_task.as_ref(),
                                &prompt,
                            )
                        } else {
                            let runtime_message = build_chatroom_runtime_message(
                                &room,
                                &advisor_name,
                                &rolling_history,
                                &message_for_task,
                                context_for_task.as_ref(),
                                &advisors_for_task,
                            );
                            let session = match ensure_chatroom_advisor_runtime_session(
                                &managed_state,
                                &room,
                                advisor_id,
                                &advisor_name,
                            ) {
                                Ok(session) => session,
                                Err(error) => {
                                    emit_creative_chat_checkpoint(
                                        &app_handle,
                                        &room_id_for_task,
                                        "creative_chat.error",
                                        json!({
                                            "roomId": room_id_for_task.clone(),
                                            "advisorId": advisor_id,
                                            "message": error
                                        }),
                                    );
                                    continue;
                                }
                            };
                            let previous_tool_count = with_store(&managed_state, |store| {
                                Ok(tool_results_for_session(&store, &session.id).len())
                            })
                            .unwrap_or_default();
                            let runtime_payload = json!({
                                "sessionId": session.id,
                                "message": runtime_message,
                                "modelConfig": model_config_for_task.clone()
                            });
                            match handle_runtime_query(
                                &app_handle,
                                &managed_state,
                                &runtime_payload,
                            ) {
                                Ok(value) => {
                                    let response =
                                        payload_string(&value, "response").unwrap_or_default();
                                    let tool_results = collect_runtime_tool_results_after(
                                        &managed_state,
                                        payload_string(&value, "sessionId")
                                            .as_deref()
                                            .unwrap_or(&session.id),
                                        previous_tool_count,
                                    )
                                    .unwrap_or_default();
                                    emit_chatroom_runtime_tool_summaries(
                                        &app_handle,
                                        &room_id_for_task,
                                        advisor_id,
                                        &tool_results,
                                    );
                                    response
                                }
                                Err(error) => {
                                    emit_creative_chat_checkpoint(
                                        &app_handle,
                                        &room_id_for_task,
                                        "creative_chat.error",
                                        json!({
                                            "roomId": room_id_for_task.clone(),
                                            "advisorId": advisor_id,
                                            "message": error
                                        }),
                                    );
                                    continue;
                                }
                            }
                        };
                        if is_chatroom_cancelled(&managed_state, &room_id_for_task) {
                            break;
                        }
                        eprintln!(
                            "[creative-chat][advisor-response] roomId={} advisorId={} chars={}",
                            room_id_for_task,
                            advisor_id,
                            response.chars().count()
                        );
                        emit_creative_chat_checkpoint(
                            &app_handle,
                            &room_id_for_task,
                            "creative_chat.thinking",
                            json!({
                                "roomId": room_id_for_task.clone(),
                                "advisorId": advisor_id,
                                "type": "thinking_end",
                                "content": "分析完成"
                            }),
                        );
                        for chunk in split_stream_chunks(&response, 140) {
                            if is_chatroom_cancelled(&managed_state, &room_id_for_task) {
                                break;
                            }
                            emit_creative_chat_checkpoint(
                                &app_handle,
                                &room_id_for_task,
                                "creative_chat.stream",
                                json!({
                                    "roomId": room_id_for_task.clone(),
                                    "advisorId": advisor_id,
                                    "advisorName": if advisor_id == "director-system" { "总监" } else { &advisor_name },
                                    "advisorAvatar": if advisor_id == "director-system" { "🎯" } else { &advisor_avatar },
                                    "content": chunk,
                                    "done": false
                                }),
                            );
                        }
                        if is_chatroom_cancelled(&managed_state, &room_id_for_task) {
                            break;
                        }
                        let ai_message = ChatRoomMessageRecord {
                            id: make_id("chatroom-message"),
                            room_id: room_id_for_task.clone(),
                            role: if advisor_id == "director-system" {
                                "director".to_string()
                            } else {
                                "advisor".to_string()
                            },
                            advisor_id: Some(advisor_id.clone()),
                            advisor_name: Some(advisor_name.clone()),
                            advisor_avatar: Some(advisor_avatar.clone()),
                            content: response.clone(),
                            timestamp: now_iso(),
                            is_streaming: Some(false),
                            phase: Some(phase.clone()),
                        };
                        let _ = append_chatroom_message_to_file(&managed_state, &room, &ai_message);
                        rolling_history.push(ai_message.clone());
                        emit_creative_chat_checkpoint(
                            &app_handle,
                            &room_id_for_task,
                            "creative_chat.stream",
                            json!({
                                "roomId": room_id_for_task.clone(),
                                "advisorId": advisor_id,
                                "advisorName": advisor_name,
                                "advisorAvatar": advisor_avatar,
                                "content": "",
                                "done": true
                            }),
                        );
                    }

                    clear_chatroom_cancel(&managed_state, &room_id_for_task);
                    emit_creative_chat_checkpoint(
                        &app_handle,
                        &room_id_for_task,
                        "creative_chat.done",
                        json!({ "roomId": room_id_for_task }),
                    );
                    eprintln!("[creative-chat][done] roomId={}", room_id_for_task);
                });
                Ok(json!({ "success": true }))
            }
            _ => unreachable!(),
        }
    })())
}
