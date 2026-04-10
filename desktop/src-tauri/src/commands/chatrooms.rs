use crate::persistence::{with_store, with_store_mut};
use crate::*;
use serde_json::{json, Value};
use tauri::{AppHandle, State};

use crate::events::emit_creative_chat_checkpoint;

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
            "chatrooms:list" => with_store(state, |store| {
                let mut rooms = store.chat_rooms.clone();
                rooms.sort_by(|a, b| b.created_at.cmp(&a.created_at));
                Ok(json!(rooms))
            }),
            "chatrooms:messages" => {
                let room_id = payload_value_as_string(payload).unwrap_or_default();
                with_store(state, |store| {
                    let mut items: Vec<ChatRoomMessageRecord> = store
                        .chatroom_messages
                        .iter()
                        .filter(|item| item.room_id == room_id)
                        .cloned()
                        .collect();
                    items.sort_by(|a, b| a.timestamp.cmp(&b.timestamp));
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
                Ok(result)
            }
            "chatrooms:send" => {
                let room_id = payload_string(payload, "roomId").unwrap_or_default();
                let message = payload_string(payload, "message").unwrap_or_default();
                let context = payload_field(payload, "context").cloned();
                if room_id.trim().is_empty() || message.trim().is_empty() {
                    return Ok(json!({ "success": false, "error": "缺少 roomId 或 message" }));
                }
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
                    id: make_id("chatroom-message"),
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
                with_store_mut(state, |store| {
                    store.chatroom_messages.push(user_message.clone());
                    Ok(())
                })?;
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

                for (index, advisor_id) in target_advisor_ids.iter().enumerate() {
                    let advisor = advisors.iter().find(|item| item.id == *advisor_id);
                    let advisor_name = if advisor_id == "director-system" {
                        "总监".to_string()
                    } else {
                        find_advisor_name(&advisors, advisor_id)
                    };
                    let advisor_avatar = if advisor_id == "director-system" {
                        "🎯".to_string()
                    } else {
                        find_advisor_avatar(&advisors, advisor_id)
                    };
                    let phase = chatroom_response_phase(index, target_advisor_ids.len());
                    emit_creative_chat_checkpoint(
                        app,
                        &room_id,
                        "creative_chat.advisor_start",
                        json!({
                            "roomId": room_id.clone(),
                            "advisorId": advisor_id,
                            "advisorName": advisor_name,
                            "advisorAvatar": advisor_avatar,
                            "phase": phase
                        }),
                    );
                    emit_creative_chat_checkpoint(
                        app,
                        &room_id,
                        "creative_chat.thinking",
                        json!({
                            "roomId": room_id.clone(),
                            "advisorId": advisor_id,
                            "type": "thinking_start",
                            "content": "正在分析群聊上下文..."
                        }),
                    );
                    let prompt = build_advisor_prompt(advisor, &message, context.as_ref());
                    let response =
                        generate_response_with_settings(&settings_snapshot, None, &prompt);
                    emit_creative_chat_checkpoint(
                        app,
                        &room_id,
                        "creative_chat.thinking",
                        json!({
                            "roomId": room_id.clone(),
                            "advisorId": advisor_id,
                            "type": "thinking_end",
                            "content": "分析完成"
                        }),
                    );
                    for chunk in split_stream_chunks(&response, 140) {
                        emit_creative_chat_checkpoint(
                            app,
                            &room_id,
                            "creative_chat.stream",
                            json!({
                                "roomId": room_id.clone(),
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
                        room_id: room_id.clone(),
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
                    with_store_mut(state, |store| {
                        store.chatroom_messages.push(ai_message);
                        Ok(())
                    })?;
                    emit_creative_chat_checkpoint(
                        app,
                        &room_id,
                        "creative_chat.stream",
                        json!({
                            "roomId": room_id.clone(),
                            "advisorId": advisor_id,
                            "advisorName": advisor_name,
                            "advisorAvatar": advisor_avatar,
                            "content": "",
                            "done": true
                        }),
                    );
                }

                emit_creative_chat_checkpoint(
                    app,
                    &room_id,
                    "creative_chat.done",
                    json!({ "roomId": room_id }),
                );
                Ok(json!({ "success": true }))
            }
            _ => unreachable!(),
        }
    })())
}
