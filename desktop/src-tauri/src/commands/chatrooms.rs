use crate::persistence::{with_store, with_store_mut};
use crate::*;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, State};

use crate::events::emit_creative_chat_checkpoint;
use std::fs;
use std::path::PathBuf;

const SIX_HATS_ROOM_ID: &str = "system_six_thinking_hats";
const SIX_HATS_ROOM_NAME: &str = "六顶思考帽";
const SYSTEM_ROOMS_STATE_FILE: &str = ".system_rooms_state.json";
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
            | "chatrooms:send"
    ) {
        return None;
    }

    Some((|| -> Result<Value, String> {
        match channel {
            "chatrooms:list" => {
                let _ = ensure_six_hats_room(state);
                let _ = with_store_mut(state, |store| {
                    hydrate_store_from_workspace_files(store, &state.store_path)?;
                    Ok(())
                });
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
                let _ = with_store_mut(state, |store| {
                    hydrate_store_from_workspace_files(store, &state.store_path)?;
                    Ok(())
                });
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
            "chatrooms:send" => {
                let room_id = payload_string(payload, "roomId").unwrap_or_default();
                let message = payload_string(payload, "message").unwrap_or_default();
                let client_message_id = payload_string(payload, "clientMessageId");
                let context = payload_field(payload, "context").cloned();
                if room_id.trim().is_empty() || message.trim().is_empty() {
                    return Ok(json!({ "success": false, "error": "缺少 roomId 或 message" }));
                }
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
                let advisors_for_task = advisors.clone();
                let target_advisor_ids_for_task = target_advisor_ids.clone();
                tauri::async_runtime::spawn(async move {
                    let managed_state = app_handle.state::<AppState>();
                    eprintln!(
                        "[creative-chat][spawned] roomId={} advisorCount={}",
                        room_id_for_task,
                        target_advisor_ids_for_task.len()
                    );
                    for (index, advisor_id) in target_advisor_ids_for_task.iter().enumerate() {
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
                                "content": "正在分析群聊上下文..."
                            }),
                        );
                        let prompt = build_advisor_prompt(
                            advisor,
                            &message_for_task,
                            context_for_task.as_ref(),
                        );
                        let response =
                            generate_response_with_settings(&settings_snapshot, None, &prompt);
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
