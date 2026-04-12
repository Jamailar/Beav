use crate::persistence::{ensure_store_hydrated_for_advisors, with_store, with_store_mut};
use crate::*;
use serde_json::{json, Value};
use std::fs;
use tauri::{AppHandle, Emitter, State};

fn refresh_advisor_videos(
    state: &State<'_, AppState>,
    advisor_id: &str,
    limit: i64,
) -> Result<Value, String> {
    with_store_mut(state, |store| {
        let Some(advisor) = store.advisors.iter_mut().find(|item| item.id == advisor_id) else {
            return Ok(json!({ "success": false, "error": "成员不存在" }));
        };
        let channel = advisor.youtube_channel.clone().unwrap_or_else(|| {
            build_advisor_youtube_channel(None, "https://youtube.com/@redbox", "redbox")
        });
        let url = channel
            .get("url")
            .and_then(|value| value.as_str())
            .unwrap_or("https://youtube.com/@redbox");
        let (fallback_channel_id, fallback_channel_name) = parse_youtube_channel(url);
        let fetched = detect_ytdlp().and_then(|_| fetch_ytdlp_channel_info(url, limit).ok());
        let channel_id = fetched
            .as_ref()
            .and_then(|value| value.get("channel_id").and_then(|item| item.as_str()))
            .map(|item| item.to_string())
            .unwrap_or(fallback_channel_id);
        let channel_name = fetched
            .as_ref()
            .and_then(|value| {
                value
                    .get("channel")
                    .or_else(|| value.get("uploader"))
                    .or_else(|| value.get("title"))
                    .and_then(|item| item.as_str())
            })
            .map(|item| item.to_string())
            .unwrap_or(fallback_channel_name);
        let next_videos = fetched
            .as_ref()
            .map(|value| parse_ytdlp_videos(advisor_id, Some(&channel_id), value))
            .unwrap_or_else(|| {
                (0..limit)
                    .map(|index| AdvisorVideoRecord {
                        id: format!("{}-pending-{}", channel_id, index + 1),
                        advisor_id: advisor_id.to_string(),
                        title: format!("{} · 新视频 {}", channel_name, index + 1),
                        published_at: now_iso(),
                        status: "pending".to_string(),
                        retry_count: 0,
                        error_message: None,
                        subtitle_file: None,
                        video_url: Some(format!(
                            "{}/videos/{}",
                            url.trim_end_matches('/'),
                            format!("{}-pending-{}", channel_id, index + 1)
                        )),
                        channel_id: Some(channel_id.clone()),
                        created_at: now_iso(),
                        updated_at: now_iso(),
                    })
                    .collect::<Vec<_>>()
            });
        for next_video in next_videos {
            if let Some(existing) = store
                .advisor_videos
                .iter_mut()
                .find(|item| item.id == next_video.id && item.advisor_id == advisor_id)
            {
                existing.title = next_video.title.clone();
                existing.published_at = next_video.published_at.clone();
                existing.video_url = next_video.video_url.clone();
                existing.channel_id = next_video.channel_id.clone();
                existing.updated_at = now_iso();
            } else {
                store.advisor_videos.push(next_video);
            }
        }
        advisor.youtube_channel = Some(build_advisor_youtube_channel(
            Some(&channel),
            url,
            &channel_id,
        ));
        advisor.updated_at = now_iso();
        let mut videos: Vec<AdvisorVideoRecord> = store
            .advisor_videos
            .iter()
            .filter(|item| item.advisor_id == advisor_id)
            .cloned()
            .collect();
        videos.sort_by(|a, b| b.published_at.cmp(&a.published_at));
        Ok(json!({ "success": true, "videos": videos }))
    })
}

pub fn handle_advisor_channel(
    app: &AppHandle,
    state: &State<'_, AppState>,
    channel: &str,
    payload: &Value,
) -> Option<Result<Value, String>> {
    if !matches!(
        channel,
        "advisors:list"
            | "advisors:create"
            | "advisors:update"
            | "advisors:delete"
            | "advisors:upload-knowledge"
            | "advisors:delete-knowledge"
            | "advisors:optimize-prompt"
            | "advisors:optimize-prompt-deep"
            | "advisors:generate-persona"
            | "advisors:select-avatar"
            | "advisors:youtube-runner-status"
            | "advisors:fetch-youtube-info"
            | "advisors:download-youtube-subtitles"
            | "advisors:get-videos"
            | "advisors:refresh-videos"
            | "advisors:download-video"
            | "advisors:retry-failed"
            | "advisors:update-youtube-settings"
            | "advisors:youtube-runner-run-now"
            | "youtube:check-ytdlp"
            | "youtube:install"
            | "youtube:update"
    ) {
        return None;
    }

    Some((|| -> Result<Value, String> {
        match channel {
            "advisors:list" => {
                let _ = ensure_store_hydrated_for_advisors(state);
                with_store(state, |store| {
                    let mut advisors = store.advisors.clone();
                    advisors.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
                    Ok(json!(advisors))
                })
            }
            "advisors:create" => {
                let advisor = with_store_mut(state, |store| {
                    let timestamp = now_iso();
                    let advisor = AdvisorRecord {
                        id: make_id("advisor"),
                        name: payload_string(payload, "name")
                            .unwrap_or_else(|| "未命名成员".to_string()),
                        avatar: payload_string(payload, "avatar")
                            .unwrap_or_else(|| "🧠".to_string()),
                        personality: payload_string(payload, "personality").unwrap_or_default(),
                        system_prompt: payload_string(payload, "systemPrompt").unwrap_or_default(),
                        knowledge_language: normalize_optional_string(payload_string(
                            payload,
                            "knowledgeLanguage",
                        )),
                        knowledge_files: Vec::new(),
                        youtube_channel: payload_field(payload, "youtubeChannel").cloned(),
                        created_at: timestamp.clone(),
                        updated_at: timestamp,
                    };
                    store.advisors.push(advisor.clone());
                    Ok(advisor)
                })?;
                let _ = app.emit(
                    "advisors:changed",
                    json!({ "advisorId": advisor.id.clone() }),
                );
                Ok(json!({ "success": true, "id": advisor.id }))
            }
            "advisors:update" => {
                let advisor_id = payload_string(payload, "id").unwrap_or_default();
                let result = with_store_mut(state, |store| {
                    let Some(advisor) =
                        store.advisors.iter_mut().find(|item| item.id == advisor_id)
                    else {
                        return Ok(json!({ "success": false, "error": "成员不存在" }));
                    };
                    if let Some(name) = payload_string(payload, "name") {
                        advisor.name = name;
                    }
                    if let Some(avatar) = payload_string(payload, "avatar") {
                        advisor.avatar = avatar;
                    }
                    if let Some(personality) = payload_string(payload, "personality") {
                        advisor.personality = personality;
                    }
                    if let Some(system_prompt) = payload_string(payload, "systemPrompt") {
                        advisor.system_prompt = system_prompt;
                    }
                    if payload_field(payload, "knowledgeLanguage").is_some() {
                        advisor.knowledge_language =
                            normalize_optional_string(payload_string(payload, "knowledgeLanguage"));
                    }
                    if let Some(youtube_channel) = payload_field(payload, "youtubeChannel") {
                        advisor.youtube_channel = Some(youtube_channel.clone());
                    }
                    advisor.updated_at = now_iso();
                    Ok(json!({ "success": true, "advisor": advisor.clone() }))
                })?;
                let _ = app.emit("advisors:changed", json!({ "advisorId": advisor_id }));
                Ok(result)
            }
            "advisors:delete" => {
                let advisor_id = payload_value_as_string(payload).unwrap_or_default();
                let result = with_store_mut(state, |store| {
                    store.advisors.retain(|item| item.id != advisor_id);
                    store
                        .advisor_videos
                        .retain(|item| item.advisor_id != advisor_id);
                    for room in &mut store.chat_rooms {
                        room.advisor_ids.retain(|item| item != &advisor_id);
                    }
                    Ok(json!({ "success": true }))
                })?;
                let _ = app.emit("advisors:changed", json!({ "advisorId": advisor_id }));
                Ok(result)
            }
            "advisors:upload-knowledge" => {
                let advisor_id = payload_value_as_string(payload).unwrap_or_default();
                let selected = pick_files_native("选择要导入该成员知识库的文件", false, true)?;
                if selected.is_empty() {
                    return Ok(json!({ "success": false, "error": "未选择文件" }));
                }
                let target_dir = advisor_knowledge_dir(state, &advisor_id)?;
                let imported = with_store_mut(state, |store| {
                    let Some(advisor) =
                        store.advisors.iter_mut().find(|item| item.id == advisor_id)
                    else {
                        return Ok(json!({ "success": false, "error": "成员不存在" }));
                    };
                    let mut imported_files = Vec::new();
                    for file in &selected {
                        let (relative_name, _) = copy_file_into_dir(file, &target_dir)?;
                        if !advisor.knowledge_files.contains(&relative_name) {
                            advisor.knowledge_files.push(relative_name.clone());
                        }
                        imported_files.push(relative_name);
                    }
                    advisor.updated_at = now_iso();
                    Ok(json!({ "success": true, "files": imported_files }))
                })?;
                let _ = app.emit("advisors:changed", json!({ "advisorId": advisor_id }));
                Ok(imported)
            }
            "advisors:delete-knowledge" => {
                let advisor_id = payload_string(payload, "advisorId").unwrap_or_default();
                let file_name = payload_string(payload, "fileName").unwrap_or_default();
                let result = with_store_mut(state, |store| {
                    let Some(advisor) =
                        store.advisors.iter_mut().find(|item| item.id == advisor_id)
                    else {
                        return Ok(json!({ "success": false, "error": "成员不存在" }));
                    };
                    advisor.knowledge_files.retain(|item| item != &file_name);
                    advisor.updated_at = now_iso();
                    Ok(json!({ "success": true }))
                })?;
                let path = advisor_knowledge_dir(state, &advisor_id)?.join(&file_name);
                let _ = fs::remove_file(path);
                let _ = app.emit("advisors:changed", json!({ "advisorId": advisor_id }));
                Ok(result)
            }
            "advisors:optimize-prompt" => {
                let settings_snapshot = with_store(state, |store| Ok(store.settings.clone()))?;
                let info = payload_string(payload, "info").unwrap_or_default();
                let system_prompt = load_redbox_prompt_or_embedded(
                    "runtime/advisors/optimize_system.txt",
                    include_str!("../../../prompts/library/runtime/advisors/optimize_system.txt"),
                );
                let optimized = generate_structured_response_with_settings(
                    &settings_snapshot,
                    None,
                    &system_prompt,
                    &info,
                    false,
                )
                .unwrap_or_else(|_| {
                    generate_response_with_settings(&settings_snapshot, None, &info)
                });
                Ok(json!({ "success": true, "prompt": optimized }))
            }
            "advisors:optimize-prompt-deep" => {
                let settings_snapshot = with_store(state, |store| Ok(store.settings.clone()))?;
                let name =
                    payload_string(payload, "name").unwrap_or_else(|| "智囊团成员".to_string());
                let personality = payload_string(payload, "personality").unwrap_or_default();
                let current_prompt = payload_string(payload, "currentPrompt").unwrap_or_default();
                let system_prompt = load_redbox_prompt_or_embedded(
                    "runtime/advisors/optimize_deep_system.txt",
                    include_str!(
                        "../../../prompts/library/runtime/advisors/optimize_deep_system.txt"
                    ),
                );
                let user_prompt = render_redbox_prompt(
                    &load_redbox_prompt_or_embedded(
                        "runtime/advisors/optimize_deep_user.txt",
                        include_str!(
                            "../../../prompts/library/runtime/advisors/optimize_deep_user.txt"
                        ),
                    ),
                    &[
                        ("name", name.clone()),
                        ("personality", personality.clone()),
                        ("current_prompt", current_prompt.clone()),
                        ("search_summary", "".to_string()),
                        ("knowledge_summary", "".to_string()),
                    ],
                );
                let optimized = generate_structured_response_with_settings(
                    &settings_snapshot,
                    None,
                    &system_prompt,
                    &user_prompt,
                    false,
                )
                .unwrap_or_else(|_| {
                    generate_response_with_settings(&settings_snapshot, None, &user_prompt)
                });
                Ok(json!({ "success": true, "prompt": optimized }))
            }
            "advisors:generate-persona" => {
                let settings_snapshot = with_store(state, |store| Ok(store.settings.clone()))?;
                let advisor_id = payload_string(payload, "advisorId").unwrap_or_default();
                let channel_name = payload_string(payload, "channelName")
                    .unwrap_or_else(|| "YouTube 频道".to_string());
                let channel_description =
                    payload_string(payload, "channelDescription").unwrap_or_default();
                let video_titles = payload_field(payload, "videoTitles")
                    .and_then(|value| value.as_array())
                    .map(|items| {
                        items
                            .iter()
                            .filter_map(|item| item.as_str())
                            .collect::<Vec<_>>()
                            .join(" / ")
                    })
                    .unwrap_or_default();
                let knowledge_language = payload_string(payload, "knowledgeLanguage")
                    .unwrap_or_else(|| "中文".to_string());
                let subject_names = vec![channel_name.clone()];
                let existing_context = with_store(state, |store| {
                    Ok(load_advisor_existing_context(&store, &advisor_id))
                })?;
                let advisor_knowledge = collect_advisor_knowledge_evidence(state, &advisor_id)?;
                let manuscript_evidence =
                    collect_related_manuscript_evidence(state, &subject_names)?;
                let search_results = search_web_with_settings(
                    &settings_snapshot,
                    &format!("{channel_name} YouTube 博主 创作者 频道定位 内容风格"),
                    6,
                )
                .unwrap_or_default();
                let (skill_name, skill_body, skill_references, skill_scripts) =
                    load_skill_bundle_sections(state, "agent-persona-creator");
                let search_summary = if search_results.is_empty() {
                    "(无外部搜索结果)".to_string()
                } else {
                    search_results
                        .iter()
                        .enumerate()
                        .map(|(index, item)| {
                            format!(
                                "Result {}\nTitle: {}\nURL: {}\nSnippet: {}",
                                index + 1,
                                item.get("title")
                                    .and_then(|value| value.as_str())
                                    .unwrap_or(""),
                                item.get("url")
                                    .and_then(|value| value.as_str())
                                    .unwrap_or(""),
                                item.get("snippet")
                                    .and_then(|value| value.as_str())
                                    .unwrap_or(""),
                            )
                        })
                        .collect::<Vec<_>>()
                        .join("\n\n")
                };
                let research_system_prompt =
                    load_redbox_prompt("runtime/advisors/generate_persona_research_system.txt")
                        .map(|template| {
                            render_redbox_prompt(
                                &template,
                                &[
                                    ("skill_name", skill_name.clone()),
                                    ("skill_body", skill_body.clone()),
                                    ("skill_references", skill_references.clone()),
                                    ("skill_scripts", skill_scripts.clone()),
                                ],
                            )
                        })
                        .unwrap_or_else(|| {
                            "你是 RedBox 内部的智囊团角色研究代理，负责做角色研究并输出严格 JSON。"
                                .to_string()
                        });
                let research_user_template =
                    load_redbox_prompt("runtime/advisors/generate_persona_research_user.txt")
                        .unwrap_or_else(|| "请根据证据做角色研究并输出严格 JSON。".to_string());
                let research_user_prompt = render_redbox_prompt(
                    &research_user_template,
                    &[
                        ("channel_name", channel_name.clone()),
                        ("knowledge_language", knowledge_language.clone()),
                        (
                            "channel_description",
                            if channel_description.trim().is_empty() {
                                "(无频道描述)".to_string()
                            } else {
                                channel_description.clone()
                            },
                        ),
                        (
                            "video_titles",
                            if video_titles.trim().is_empty() {
                                "(无视频标题)".to_string()
                            } else {
                                video_titles
                                    .split(" / ")
                                    .enumerate()
                                    .map(|(index, title)| format!("{}. {}", index + 1, title))
                                    .collect::<Vec<_>>()
                                    .join("\n")
                            },
                        ),
                        ("search_summary", search_summary.clone()),
                        ("existing_context", existing_context),
                        (
                            "advisor_knowledge_corpus",
                            render_named_corpus(
                                "Knowledge Evidence",
                                &advisor_knowledge,
                                "(无 advisor 知识文件)",
                            ),
                        ),
                        (
                            "manuscript_corpus",
                            render_named_corpus(
                                "Manuscript Evidence",
                                &manuscript_evidence,
                                "(无关联稿件命中)",
                            ),
                        ),
                    ],
                );
                let research_raw = generate_structured_response_with_settings(
                    &settings_snapshot,
                    None,
                    &research_system_prompt,
                    &research_user_prompt,
                    true,
                )
                .unwrap_or_else(|_| {
                    generate_response_with_settings(
                        &settings_snapshot,
                        None,
                        &format!(
                            "请为一个基于 YouTube 频道创建的智囊团成员生成研究 JSON。频道名：{}，频道简介：{}，视频标题：{}",
                            channel_name, channel_description, video_titles
                        ),
                    )
                });
                let research =
                    parse_json_value_from_text(&research_raw).unwrap_or_else(|| json!({}));
                let final_system_prompt =
                    load_redbox_prompt("runtime/advisors/generate_persona_final_system.txt")
                        .map(|template| {
                            render_redbox_prompt(
                                &template,
                                &[
                                    ("skill_name", skill_name),
                                    ("skill_body", skill_body),
                                    ("skill_references", skill_references),
                                    ("skill_scripts", skill_scripts),
                                ],
                            )
                        })
                        .unwrap_or_else(|| {
                            "你是 RedBox 内部的智囊团角色文档生成代理，只输出最终 Markdown 文档。"
                                .to_string()
                        });
                let final_user_template =
                    load_redbox_prompt("runtime/advisors/generate_persona_final_user.txt")
                        .unwrap_or_else(|| "请根据研究结果输出最终智囊团角色文档。".to_string());
                let final_user_prompt = render_redbox_prompt(
                    &final_user_template,
                    &[
                        ("channel_name", channel_name.clone()),
                        ("knowledge_language", knowledge_language),
                        (
                            "research_json",
                            serde_json::to_string_pretty(&research)
                                .unwrap_or_else(|_| "{}".to_string()),
                        ),
                        ("search_summary", search_summary),
                        (
                            "advisor_knowledge_corpus",
                            render_named_corpus(
                                "Knowledge Evidence",
                                &advisor_knowledge,
                                "(无 advisor 知识文件)",
                            ),
                        ),
                        (
                            "manuscript_corpus",
                            render_named_corpus(
                                "Manuscript Evidence",
                                &manuscript_evidence,
                                "(无关联稿件命中)",
                            ),
                        ),
                    ],
                );
                let final_markdown = generate_structured_response_with_settings(
                    &settings_snapshot,
                    None,
                    &final_system_prompt,
                    &final_user_prompt,
                    false,
                )
                .unwrap_or_else(|_| {
                    generate_response_with_settings(&settings_snapshot, None, &final_user_prompt)
                });
                let prompt = research
                    .get("prompt")
                    .and_then(|value| value.as_str())
                    .map(|value| value.to_string())
                    .filter(|value| !value.trim().is_empty())
                    .or_else(|| {
                        research
                            .get("description")
                            .and_then(|value| value.as_str())
                            .map(ToString::to_string)
                    })
                    .unwrap_or_else(|| final_markdown.clone());
                let personality = research
                    .get("personality")
                    .and_then(|value| value.as_str())
                    .map(|value| value.to_string())
                    .filter(|value| !value.trim().is_empty())
                    .or_else(|| {
                        research
                            .get("personality_summary")
                            .and_then(|value| value.as_str())
                            .map(ToString::to_string)
                    })
                    .unwrap_or_else(|| format!("模仿 {} 的内容风格与表达方式", channel_name));
                Ok(json!({
                    "success": true,
                    "prompt": final_markdown,
                    "personality": personality,
                    "research": research,
                    "systemPrompt": prompt
                }))
            }
            "advisors:select-avatar" => {
                let selected = pick_files_native("选择成员头像图片", false, false)?;
                let Some(path) = selected.into_iter().next() else {
                    return Ok(Value::Null);
                };
                let target_dir = advisor_avatar_dir(state)?;
                let (_, copied) = copy_file_into_dir(&path, &target_dir)?;
                Ok(json!(file_url_for_path(&copied)))
            }
            "advisors:youtube-runner-status" => {
                let status = with_store(state, |store| {
                    let enabled = store.advisors.iter().any(|advisor| {
                        advisor
                            .youtube_channel
                            .as_ref()
                            .and_then(|value| value.get("backgroundEnabled"))
                            .and_then(|value| value.as_bool())
                            .unwrap_or(false)
                    });
                    Ok(json!({
                        "success": true,
                        "status": {
                            "enabled": enabled,
                            "isTicking": false,
                            "tickIntervalMinutes": 180,
                            "lastTickAt": store.legacy_imported_at,
                            "nextTickAt": Value::Null,
                            "lastError": Value::Null
                        }
                    }))
                })?;
                Ok(status)
            }
            "advisors:fetch-youtube-info" => {
                let channel_url = payload_string(payload, "channelUrl").unwrap_or_default();
                let (fallback_channel_id, fallback_channel_name) =
                    parse_youtube_channel(&channel_url);
                let fetched =
                    detect_ytdlp().and_then(|_| fetch_ytdlp_channel_info(&channel_url, 6).ok());
                let channel_id = fetched
                    .as_ref()
                    .and_then(|value| value.get("channel_id").and_then(|item| item.as_str()))
                    .map(|item| item.to_string())
                    .unwrap_or(fallback_channel_id);
                let channel_name = fetched
                    .as_ref()
                    .and_then(|value| {
                        value
                            .get("channel")
                            .or_else(|| value.get("uploader"))
                            .or_else(|| value.get("title"))
                            .and_then(|item| item.as_str())
                    })
                    .map(|item| item.to_string())
                    .unwrap_or(fallback_channel_name);
                let channel_description = fetched
                    .as_ref()
                    .and_then(|value| value.get("description").and_then(|item| item.as_str()))
                    .map(|item| item.to_string())
                    .unwrap_or_else(|| {
                        format!("RedBox 已根据频道链接 {} 建立本地频道画像。", channel_url)
                    });
                let avatar_url = fetched
                    .as_ref()
                    .and_then(|value| {
                        value
                            .get("thumbnails")
                            .and_then(|item| item.as_array())
                            .and_then(|items| items.last())
                            .and_then(|item| item.get("url"))
                            .and_then(|item| item.as_str())
                    })
                    .unwrap_or("")
                    .to_string();
                let recent_videos = fetched
                    .as_ref()
                    .map(|value| {
                        value
                            .get("entries")
                            .and_then(|item| item.as_array())
                            .cloned()
                            .unwrap_or_default()
                            .into_iter()
                            .take(5)
                            .filter_map(|entry| {
                                let id = entry.get("id").and_then(|item| item.as_str())?;
                                let title = entry
                                    .get("title")
                                    .and_then(|item| item.as_str())
                                    .unwrap_or("Untitled");
                                Some(json!({ "id": id, "title": title }))
                            })
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_else(|| {
                        (0..5)
                            .map(|index| {
                                json!({
                                    "id": format!("{}-{}", channel_id, index + 1),
                                    "title": format!("{} · 最近视频 {}", channel_name, index + 1)
                                })
                            })
                            .collect::<Vec<_>>()
                    });
                Ok(json!({
                    "success": true,
                    "data": {
                        "channelId": channel_id,
                        "channelName": channel_name,
                        "channelDescription": channel_description,
                        "avatarUrl": avatar_url,
                        "recentVideos": recent_videos
                    }
                }))
            }
            "advisors:download-youtube-subtitles" => {
                let advisor_id = payload_string(payload, "advisorId").unwrap_or_default();
                let channel_url = payload_string(payload, "channelUrl").unwrap_or_default();
                let count = payload_field(payload, "videoCount")
                    .and_then(|value| value.as_i64())
                    .unwrap_or(10)
                    .max(1);
                let (fallback_channel_id, fallback_channel_name) =
                    parse_youtube_channel(&channel_url);
                let fetched =
                    detect_ytdlp().and_then(|_| fetch_ytdlp_channel_info(&channel_url, count).ok());
                let channel_id = fetched
                    .as_ref()
                    .and_then(|value| value.get("channel_id").and_then(|item| item.as_str()))
                    .map(|item| item.to_string())
                    .unwrap_or(fallback_channel_id);
                let channel_name = fetched
                    .as_ref()
                    .and_then(|value| {
                        value
                            .get("channel")
                            .or_else(|| value.get("uploader"))
                            .or_else(|| value.get("title"))
                            .and_then(|item| item.as_str())
                    })
                    .map(|item| item.to_string())
                    .unwrap_or(fallback_channel_name);
                let real_videos = fetched
                    .as_ref()
                    .map(|value| parse_ytdlp_videos(&advisor_id, Some(&channel_id), value))
                    .unwrap_or_default();
                let knowledge_dir = advisor_knowledge_dir(state, &advisor_id)?;
                let mut success_count = 0_i64;
                for index in 0..count {
                    let _ = app.emit(
                        "advisors:download-progress",
                        json!({ "advisorId": advisor_id, "progress": format!("正在处理第 {} / {} 个视频...", index + 1, count) }),
                    );
                    let video = real_videos.get(index as usize).cloned().unwrap_or_else(|| {
                        AdvisorVideoRecord {
                            id: format!("{}-{}", channel_id, index + 1),
                            advisor_id: advisor_id.clone(),
                            title: format!("{} · 视频 {}", channel_name, index + 1),
                            published_at: now_iso(),
                            status: "pending".to_string(),
                            retry_count: 0,
                            error_message: None,
                            subtitle_file: None,
                            video_url: Some(format!(
                                "{}/videos/{}",
                                channel_url.trim_end_matches('/'),
                                format!("{}-{}", channel_id, index + 1)
                            )),
                            channel_id: Some(channel_id.clone()),
                            created_at: now_iso(),
                            updated_at: now_iso(),
                        }
                    });
                    let video_id = video.id.clone();
                    let subtitle_path = if let Some(video_url) = video.video_url.clone() {
                        download_ytdlp_subtitle(
                            &video_url,
                            &knowledge_dir,
                            &slug_from_relative_path(&video_id),
                        )
                        .unwrap_or_else(|_| {
                            let fallback = knowledge_dir.join(format!(
                                "{}-subtitle-{}.txt",
                                slug_from_relative_path(&channel_id),
                                index + 1
                            ));
                            let _ = fs::write(
                                &fallback,
                                format!(
                                    "RedBox generated subtitle fallback\n\n频道：{}\n视频：{}\n来源：{}\n",
                                    channel_name, video_id, channel_url
                                ),
                            );
                            fallback
                        })
                    } else {
                        let fallback = knowledge_dir.join(format!(
                            "{}-subtitle-{}.txt",
                            slug_from_relative_path(&channel_id),
                            index + 1
                        ));
                        fs::write(
                            &fallback,
                            format!(
                                "RedBox generated subtitle fallback\n\n频道：{}\n视频：{}\n来源：{}\n",
                                channel_name, video_id, channel_url
                            ),
                        )
                        .map_err(|error| error.to_string())?;
                        fallback
                    };
                    let subtitle_name = subtitle_path
                        .file_name()
                        .and_then(|value| value.to_str())
                        .unwrap_or("subtitle.txt")
                        .to_string();
                    let subtitle_content = read_text_file_or_empty(&subtitle_path);
                    let video_title = video.title.clone();
                    let video_published_at = video.published_at.clone();
                    let video_url_saved = video.video_url.clone();
                    with_store_mut(state, |store| {
                        if let Some(advisor) =
                            store.advisors.iter_mut().find(|item| item.id == advisor_id)
                        {
                            advisor.youtube_channel = Some(build_advisor_youtube_channel(
                                advisor.youtube_channel.as_ref(),
                                &channel_url,
                                &channel_id,
                            ));
                            if !advisor.knowledge_files.contains(&subtitle_name) {
                                advisor.knowledge_files.push(subtitle_name.clone());
                            }
                            advisor.updated_at = now_iso();
                        }
                        if let Some(video) = store
                            .advisor_videos
                            .iter_mut()
                            .find(|item| item.id == video_id && item.advisor_id == advisor_id)
                        {
                            video.title = video_title.clone();
                            video.published_at = video_published_at.clone();
                            video.video_url = video_url_saved.clone();
                            video.status = "success".to_string();
                            video.subtitle_file = Some(subtitle_name.clone());
                            video.updated_at = now_iso();
                            video.error_message = None;
                        } else {
                            store.advisor_videos.push(AdvisorVideoRecord {
                                id: video_id.clone(),
                                advisor_id: advisor_id.clone(),
                                title: video_title.clone(),
                                published_at: video_published_at.clone(),
                                status: "success".to_string(),
                                retry_count: 0,
                                error_message: None,
                                subtitle_file: Some(subtitle_name.clone()),
                                video_url: video_url_saved.clone(),
                                channel_id: Some(channel_id.clone()),
                                created_at: now_iso(),
                                updated_at: now_iso(),
                            });
                        }
                        if !store
                            .youtube_videos
                            .iter()
                            .any(|item| item.video_id == video_id)
                        {
                            store.youtube_videos.push(YoutubeVideoRecord {
                                id: make_id("youtube"),
                                video_id: video_id.clone(),
                                video_url: video_url_saved.clone().unwrap_or_else(|| {
                                    format!(
                                        "{}/videos/{}",
                                        channel_url.trim_end_matches('/'),
                                        video_id
                                    )
                                }),
                                title: video_title.clone(),
                                original_title: None,
                                description: format!(
                                    "Imported from advisor channel {}",
                                    channel_name
                                ),
                                summary: Some(
                                    "RedBox imported this advisor video into the knowledge store."
                                        .to_string(),
                                ),
                                thumbnail_url: "".to_string(),
                                has_subtitle: true,
                                subtitle_content: Some(subtitle_content.clone()),
                                status: Some("completed".to_string()),
                                created_at: now_iso(),
                                folder_path: Some(knowledge_dir.display().to_string()),
                            });
                        } else if let Some(existing) = store
                            .youtube_videos
                            .iter_mut()
                            .find(|item| item.video_id == video_id)
                        {
                            existing.subtitle_content = Some(subtitle_content.clone());
                            existing.has_subtitle = true;
                            existing.status = Some("completed".to_string());
                        }
                        Ok(())
                    })?;
                    success_count += 1;
                }
                let _ = app.emit(
                    "advisors:download-progress",
                    json!({ "advisorId": advisor_id, "progress": "下载完成！" }),
                );
                let _ = app.emit("advisors:changed", json!({ "advisorId": advisor_id }));
                Ok(json!({ "success": true, "successCount": success_count, "failCount": 0 }))
            }
            "advisors:get-videos" => {
                let advisor_id = payload_string(payload, "advisorId").unwrap_or_default();
                with_store(state, |store| {
                    let mut videos: Vec<AdvisorVideoRecord> = store
                        .advisor_videos
                        .iter()
                        .filter(|item| item.advisor_id == advisor_id)
                        .cloned()
                        .collect();
                    videos.sort_by(|a, b| b.published_at.cmp(&a.published_at));
                    let youtube_channel = store
                        .advisors
                        .iter()
                        .find(|item| item.id == advisor_id)
                        .and_then(|item| item.youtube_channel.clone())
                        .unwrap_or(Value::Null);
                    Ok(
                        json!({ "success": true, "videos": videos, "youtubeChannel": youtube_channel }),
                    )
                })
            }
            "advisors:refresh-videos" => {
                let advisor_id = payload_string(payload, "advisorId").unwrap_or_default();
                let limit = payload_field(payload, "limit")
                    .and_then(|value| value.as_i64())
                    .unwrap_or(20)
                    .max(1);
                refresh_advisor_videos(state, &advisor_id, limit)
            }
            "advisors:download-video" => {
                let advisor_id = payload_string(payload, "advisorId").unwrap_or_default();
                let video_id = payload_string(payload, "videoId").unwrap_or_default();
                let knowledge_dir = advisor_knowledge_dir(state, &advisor_id)?;
                let result = with_store_mut(state, |store| {
                    let Some(video) = store
                        .advisor_videos
                        .iter_mut()
                        .find(|item| item.id == video_id && item.advisor_id == advisor_id)
                    else {
                        return Ok(json!({ "success": false, "error": "视频不存在" }));
                    };
                    let subtitle_path = if let Some(video_url) = video.video_url.clone() {
                        download_ytdlp_subtitle(
                            &video_url,
                            &knowledge_dir,
                            &slug_from_relative_path(&video.id),
                        )
                        .unwrap_or_else(|_| {
                            let fallback = knowledge_dir
                                .join(format!("{}.txt", slug_from_relative_path(&video.title)));
                            let _ = fs::write(
                                &fallback,
                                format!(
                                    "RedBox subtitle fallback\n\n{}\n{}",
                                    video.title,
                                    video.video_url.clone().unwrap_or_default()
                                ),
                            );
                            fallback
                        })
                    } else {
                        let fallback = knowledge_dir
                            .join(format!("{}.txt", slug_from_relative_path(&video.title)));
                        fs::write(
                            &fallback,
                            format!(
                                "RedBox subtitle fallback\n\n{}\n{}",
                                video.title,
                                video.video_url.clone().unwrap_or_default()
                            ),
                        )
                        .map_err(|error| error.to_string())?;
                        fallback
                    };
                    let subtitle_name = subtitle_path
                        .file_name()
                        .and_then(|value| value.to_str())
                        .unwrap_or("subtitle.txt")
                        .to_string();
                    let subtitle_content = read_text_file_or_empty(&subtitle_path);
                    video.status = "success".to_string();
                    video.subtitle_file = Some(subtitle_name.clone());
                    video.error_message = None;
                    video.updated_at = now_iso();
                    if let Some(advisor) =
                        store.advisors.iter_mut().find(|item| item.id == advisor_id)
                    {
                        if !advisor.knowledge_files.contains(&subtitle_name) {
                            advisor.knowledge_files.push(subtitle_name.clone());
                        }
                        advisor.updated_at = now_iso();
                    }
                    if let Some(existing) = store
                        .youtube_videos
                        .iter_mut()
                        .find(|item| item.video_id == video_id)
                    {
                        existing.subtitle_content = Some(subtitle_content);
                        existing.has_subtitle = true;
                        existing.status = Some("completed".to_string());
                    }
                    Ok(json!({ "success": true, "subtitleFile": subtitle_name }))
                })?;
                let _ = app.emit("advisors:changed", json!({ "advisorId": advisor_id }));
                Ok(result)
            }
            "advisors:retry-failed" => {
                let advisor_id = payload_string(payload, "advisorId").unwrap_or_default();
                let knowledge_dir = advisor_knowledge_dir(state, &advisor_id)?;
                let result = with_store_mut(state, |store| {
                    let mut success_count = 0_i64;
                    let mut fail_count = 0_i64;
                    for video in store
                        .advisor_videos
                        .iter_mut()
                        .filter(|item| item.advisor_id == advisor_id && item.status == "failed")
                    {
                        let subtitle_result = video.video_url.clone().map(|video_url| {
                            download_ytdlp_subtitle(
                                &video_url,
                                &knowledge_dir,
                                &format!("retry-{}", slug_from_relative_path(&video.id)),
                            )
                        });
                        match subtitle_result
                            .unwrap_or_else(|| Err("missing video url".to_string()))
                        {
                            Ok(subtitle_path) => {
                                let subtitle_name = subtitle_path
                                    .file_name()
                                    .and_then(|value| value.to_str())
                                    .unwrap_or("subtitle.txt")
                                    .to_string();
                                video.status = "success".to_string();
                                video.subtitle_file = Some(subtitle_name);
                                video.error_message = None;
                                video.retry_count += 1;
                                video.updated_at = now_iso();
                                success_count += 1;
                            }
                            Err(error) => {
                                video.retry_count += 1;
                                video.error_message = Some(error.to_string());
                                fail_count += 1;
                            }
                        }
                    }
                    Ok(
                        json!({ "success": true, "successCount": success_count, "failCount": fail_count }),
                    )
                })?;
                let _ = app.emit("advisors:changed", json!({ "advisorId": advisor_id }));
                Ok(result)
            }
            "advisors:update-youtube-settings" => {
                let advisor_id = payload_string(payload, "advisorId").unwrap_or_default();
                let settings_patch = payload_field(payload, "settings")
                    .cloned()
                    .unwrap_or_else(|| json!({}));
                let result = with_store_mut(state, |store| {
                    let Some(advisor) =
                        store.advisors.iter_mut().find(|item| item.id == advisor_id)
                    else {
                        return Ok(json!({ "success": false, "error": "成员不存在" }));
                    };
                    let mut channel = advisor
                        .youtube_channel
                        .clone()
                        .unwrap_or_else(|| {
                            build_advisor_youtube_channel(
                                None,
                                "https://youtube.com/@redbox",
                                "redbox",
                            )
                        })
                        .as_object()
                        .cloned()
                        .unwrap_or_default();
                    if let Some(patch) = settings_patch.as_object() {
                        for (key, value) in patch {
                            channel.insert(key.clone(), value.clone());
                        }
                    }
                    channel.insert("lastBackgroundError".to_string(), Value::Null);
                    advisor.youtube_channel = Some(Value::Object(channel.clone()));
                    advisor.updated_at = now_iso();
                    Ok(json!({ "success": true, "youtubeChannel": Value::Object(channel) }))
                })?;
                Ok(result)
            }
            "advisors:youtube-runner-run-now" => {
                let advisor_id = payload_string(payload, "advisorId");
                let targets = with_store(state, |store| {
                    let items = store
                        .advisors
                        .iter()
                        .filter(|advisor| {
                            if let Some(target) = advisor_id.as_deref() {
                                advisor.id == target
                            } else {
                                advisor
                                    .youtube_channel
                                    .as_ref()
                                    .and_then(|value| value.get("backgroundEnabled"))
                                    .and_then(|value| value.as_bool())
                                    .unwrap_or(false)
                            }
                        })
                        .map(|advisor| advisor.id.clone())
                        .collect::<Vec<_>>();
                    Ok(items)
                })?;
                let mut processed = 0_i64;
                for target in targets {
                    let _ = refresh_advisor_videos(state, &target, 5);
                    processed += 1;
                }
                Ok(json!({ "success": true, "processed": processed }))
            }
            "youtube:check-ytdlp" => {
                let started_at = now_ms();
                let request_id = format!("youtube:check-ytdlp:{}", started_at);
                if let Some((path, version)) = detect_ytdlp() {
                    log_timing_event(
                        state,
                        "settings",
                        &request_id,
                        "youtube:check-ytdlp",
                        started_at,
                        Some("installed=true".to_string()),
                    );
                    Ok(json!({ "installed": true, "version": version, "path": path }))
                } else {
                    log_timing_event(
                        state,
                        "settings",
                        &request_id,
                        "youtube:check-ytdlp",
                        started_at,
                        Some("installed=false".to_string()),
                    );
                    Ok(json!({ "installed": false }))
                }
            }
            "youtube:install" => {
                let _ = app.emit("youtube:install-progress", 10);
                let result = match ensure_ytdlp_installed(false) {
                    Ok((path, version)) => {
                        append_debug_log_state(
                            state,
                            format!("yt-dlp install/check succeeded: {path} {version}"),
                        );
                        json!({ "success": true, "path": path, "version": version })
                    }
                    Err(error) => {
                        append_debug_log_state(
                            state,
                            format!("yt-dlp install/check failed: {error}"),
                        );
                        json!({ "success": false, "error": error })
                    }
                };
                let _ = app.emit("youtube:install-progress", 100);
                Ok(result)
            }
            "youtube:update" => {
                let _ = app.emit("youtube:install-progress", 10);
                let result = match ensure_ytdlp_installed(true) {
                    Ok((path, version)) => {
                        append_debug_log_state(
                            state,
                            format!("yt-dlp update succeeded: {path} {version}"),
                        );
                        json!({ "success": true, "path": path, "version": version })
                    }
                    Err(error) => {
                        append_debug_log_state(state, format!("yt-dlp update failed: {error}"));
                        json!({ "success": false, "error": error })
                    }
                };
                let _ = app.emit("youtube:install-progress", 100);
                Ok(result)
            }
            _ => unreachable!(),
        }
    })())
}
