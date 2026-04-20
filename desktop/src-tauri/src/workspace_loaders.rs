use serde_json::Value;
use std::fs;
use std::path::Path;
use url::Url;

use crate::{
    AdvisorRecord, ChatRoomMessageRecord, ChatRoomRecord, CoverAssetRecord,
    DocumentKnowledgeSourceRecord, KnowledgeNoteRecord, KnowledgeNoteStatsRecord, MediaAssetRecord,
    MemoryHistoryRecord, RedclawLongCycleTaskRecord, RedclawScheduledTaskRecord,
    RedclawStateRecord, SubjectAttribute, SubjectCategory, SubjectRecord, UserMemoryRecord,
    WorkItemRecord, WorkRefsRecord, WorkScheduleRecord, YoutubeVideoRecord, extract_tags_from_text,
    file_url_for_path, normalize_legacy_workspace_path, now_iso, optional_asset_url_from_note_path,
    read_text_file_or_empty, slug_from_relative_path,
};

pub(crate) fn read_json_file(path: &Path) -> Option<Value> {
    fs::read_to_string(path)
        .ok()
        .and_then(|content| serde_json::from_str::<Value>(&content).ok())
}

fn meta_string(meta: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| meta.get(*key).and_then(|value| value.as_str()))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn source_domain_from_link(link: Option<&str>) -> Option<String> {
    let raw = link?.trim();
    if raw.is_empty() {
        return None;
    }
    Url::parse(raw)
        .ok()
        .and_then(|parsed| parsed.host_str().map(|value| value.to_ascii_lowercase()))
        .filter(|value| !value.is_empty())
}

fn optional_note_asset_url(base_dir: &Path, raw: Option<&Value>) -> Option<String> {
    optional_asset_url_from_note_path(base_dir, raw).or_else(|| {
        raw.and_then(|value| value.as_str())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .and_then(|value| {
                if value.starts_with("http://")
                    || value.starts_with("https://")
                    || value.starts_with("data:")
                    || value.starts_with("blob:")
                    || value.starts_with("file:")
                {
                    Some(value.to_string())
                } else {
                    None
                }
            })
    })
}

fn note_video_asset_url(note_dir: &Path, meta: &Value) -> Option<String> {
    for key in [
        "video",
        "videoFile",
        "video_file",
        "videoPath",
        "video_path",
        "videoLocalPath",
        "video_local_path",
    ] {
        if let Some(url) = optional_note_asset_url(note_dir, meta.get(key)) {
            return Some(url);
        }
    }
    for name in [
        "video.mp4",
        "video.mov",
        "video.m4v",
        "video.webm",
        "video.mkv",
        "video.avi",
    ] {
        let candidate = normalize_legacy_workspace_path(&note_dir.join(name));
        if candidate.exists() {
            return Some(file_url_for_path(&candidate));
        }
    }
    None
}

fn read_note_transcript(note_dir: &Path, meta: &Value) -> Option<String> {
    meta_string(meta, &["transcript"]).or_else(|| {
        meta_string(meta, &["transcriptFile", "transcript_file"]).and_then(|relative_path| {
            let transcript_path = normalize_legacy_workspace_path(&note_dir.join(relative_path));
            let transcript = read_text_file_or_empty(&transcript_path);
            if transcript.trim().is_empty() {
                None
            } else {
                Some(transcript)
            }
        })
    })
}

fn extract_note_stat(meta: &Value, key: &str) -> Option<i64> {
    meta.get(key).and_then(|value| value.as_i64()).or_else(|| {
        meta.get("stats")
            .and_then(|stats| stats.get(key))
            .and_then(|value| value.as_i64())
    })
}

pub(crate) fn list_files_relative(root: &Path, limit: usize) -> Vec<String> {
    let mut items = Vec::new();
    if !root.exists() {
        return items;
    }
    if let Ok(entries) = fs::read_dir(root) {
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            if path.is_dir() {
                items.push(format!("{name}/"));
            } else {
                items.push(name);
            }
            if items.len() >= limit {
                break;
            }
        }
    }
    items
}

pub(crate) fn load_subject_categories_from_fs(subjects_root: &Path) -> Vec<SubjectCategory> {
    read_json_file(&subjects_root.join("categories.json"))
        .and_then(|value| {
            value
                .get("categories")
                .and_then(|item| item.as_array())
                .cloned()
        })
        .unwrap_or_default()
        .into_iter()
        .filter_map(|item| {
            Some(SubjectCategory {
                id: item.get("id")?.as_str()?.to_string(),
                name: item
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("未命名分类")
                    .to_string(),
                created_at: item
                    .get("createdAt")
                    .or_else(|| item.get("created_at"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("0")
                    .to_string(),
                updated_at: item
                    .get("updatedAt")
                    .or_else(|| item.get("updated_at"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("0")
                    .to_string(),
            })
        })
        .collect()
}

pub(crate) fn load_subjects_from_fs(subjects_root: &Path) -> Vec<SubjectRecord> {
    let catalog_items = read_json_file(&subjects_root.join("catalog.json"))
        .and_then(|value| {
            value
                .get("subjects")
                .and_then(|item| item.as_array())
                .cloned()
        })
        .unwrap_or_default();
    catalog_items
        .into_iter()
        .filter_map(|item| {
            let id = item.get("id")?.as_str()?.to_string();
            let subject_dir = subjects_root.join(&id);
            let image_paths = item
                .get("imagePaths")
                .and_then(|v| v.as_array())
                .map(|items| {
                    items
                        .iter()
                        .filter_map(|x| x.as_str().map(ToString::to_string))
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            let absolute_image_paths = image_paths
                .iter()
                .map(|rel| {
                    normalize_legacy_workspace_path(&subject_dir.join(rel))
                        .display()
                        .to_string()
                })
                .collect::<Vec<_>>();
            let preview_urls = absolute_image_paths
                .iter()
                .map(|abs| file_url_for_path(Path::new(abs)))
                .collect::<Vec<_>>();
            let voice_path = item
                .get("voicePath")
                .and_then(|v| v.as_str())
                .map(ToString::to_string);
            let absolute_voice_path = voice_path.as_ref().map(|rel| {
                normalize_legacy_workspace_path(&subject_dir.join(rel))
                    .display()
                    .to_string()
            });
            Some(SubjectRecord {
                id,
                name: item
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("未命名主体")
                    .to_string(),
                category_id: item
                    .get("categoryId")
                    .or_else(|| item.get("category_id"))
                    .and_then(|v| v.as_str())
                    .map(ToString::to_string),
                description: item
                    .get("description")
                    .and_then(|v| v.as_str())
                    .map(ToString::to_string),
                tags: item
                    .get("tags")
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|x| x.as_str().map(ToString::to_string))
                            .collect()
                    })
                    .unwrap_or_default(),
                attributes: item
                    .get("attributes")
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|x| {
                                Some(SubjectAttribute {
                                    key: x.get("key")?.as_str()?.to_string(),
                                    value: x
                                        .get("value")
                                        .and_then(|v| v.as_str())
                                        .unwrap_or("")
                                        .to_string(),
                                })
                            })
                            .collect()
                    })
                    .unwrap_or_default(),
                image_paths,
                voice_path,
                voice_script: item
                    .get("voiceScript")
                    .or_else(|| item.get("voice_script"))
                    .and_then(|v| v.as_str())
                    .map(ToString::to_string),
                created_at: item
                    .get("createdAt")
                    .or_else(|| item.get("created_at"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("0")
                    .to_string(),
                updated_at: item
                    .get("updatedAt")
                    .or_else(|| item.get("updated_at"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("0")
                    .to_string(),
                absolute_image_paths: absolute_image_paths.clone(),
                preview_urls: preview_urls.clone(),
                primary_preview_url: preview_urls.first().cloned(),
                absolute_voice_path: absolute_voice_path.clone(),
                voice_preview_url: absolute_voice_path
                    .as_ref()
                    .map(|abs| file_url_for_path(Path::new(abs))),
            })
        })
        .collect()
}

pub(crate) fn load_advisors_from_fs(advisors_root: &Path) -> Vec<AdvisorRecord> {
    let mut advisors = Vec::new();
    let Ok(entries) = fs::read_dir(advisors_root) else {
        return advisors;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let Some(config) = read_json_file(&path.join("config.json")) else {
            continue;
        };
        let advisor_id = entry.file_name().to_string_lossy().to_string();
        let avatar_value = config
            .get("avatar")
            .and_then(|v| v.as_str())
            .unwrap_or("🤖");
        let avatar_path = normalize_legacy_workspace_path(&path.join(avatar_value));
        let avatar = if avatar_value.contains('/') || avatar_path.exists() {
            file_url_for_path(&avatar_path)
        } else {
            avatar_value.to_string()
        };
        let knowledge_dir = path.join("knowledge");
        advisors.push(AdvisorRecord {
            id: advisor_id,
            name: config
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("未命名智囊")
                .to_string(),
            avatar,
            personality: config
                .get("personality")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            system_prompt: config
                .get("systemPrompt")
                .or_else(|| config.get("system_prompt"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            knowledge_language: config
                .get("knowledgeLanguage")
                .or_else(|| config.get("knowledge_language"))
                .and_then(|v| v.as_str())
                .map(ToString::to_string),
            knowledge_files: list_files_relative(&knowledge_dir, 20),
            youtube_channel: config
                .get("youtubeChannel")
                .or_else(|| config.get("youtube_channel"))
                .cloned(),
            created_at: config
                .get("createdAt")
                .or_else(|| config.get("created_at"))
                .and_then(|v| v.as_str())
                .unwrap_or("0")
                .to_string(),
            updated_at: config
                .get("updatedAt")
                .or_else(|| config.get("updated_at"))
                .and_then(|v| v.as_str())
                .unwrap_or("0")
                .to_string(),
        });
    }
    advisors.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    advisors
}

pub(crate) fn load_chat_rooms_from_fs(chatrooms_root: &Path) -> Vec<ChatRoomRecord> {
    let mut rooms = Vec::new();
    let Ok(entries) = fs::read_dir(chatrooms_root) else {
        return rooms;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        if path.file_name().and_then(|value| value.to_str()) == Some(".system_rooms_state.json") {
            continue;
        }
        let Some(value) = read_json_file(&path) else {
            continue;
        };
        let id = value
            .get("id")
            .and_then(|item| item.as_str())
            .map(ToString::to_string)
            .unwrap_or_else(|| {
                path.file_stem()
                    .and_then(|item| item.to_str())
                    .unwrap_or("chatroom")
                    .to_string()
            });
        let advisor_ids = value
            .get("advisorIds")
            .or_else(|| value.get("advisor_ids"))
            .and_then(|item| item.as_array())
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| item.as_str().map(ToString::to_string))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        rooms.push(ChatRoomRecord {
            id,
            name: value
                .get("name")
                .and_then(|item| item.as_str())
                .unwrap_or("未命名群聊")
                .to_string(),
            advisor_ids,
            created_at: value
                .get("createdAt")
                .or_else(|| value.get("created_at"))
                .and_then(|item| item.as_str())
                .unwrap_or("0")
                .to_string(),
            is_system: value.get("isSystem").and_then(|item| item.as_bool()),
            system_type: value
                .get("systemType")
                .or_else(|| value.get("system_type"))
                .and_then(|item| item.as_str())
                .map(ToString::to_string),
        });
    }
    rooms.sort_by(|a, b| {
        b.is_system
            .unwrap_or(false)
            .cmp(&a.is_system.unwrap_or(false))
            .then_with(|| b.created_at.cmp(&a.created_at))
    });
    rooms
}

pub(crate) fn load_chatroom_messages_from_fs(chatrooms_root: &Path) -> Vec<ChatRoomMessageRecord> {
    let mut messages = Vec::new();
    let Ok(entries) = fs::read_dir(chatrooms_root) else {
        return messages;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        if path.file_name().and_then(|value| value.to_str()) == Some(".system_rooms_state.json") {
            continue;
        }
        let Some(value) = read_json_file(&path) else {
            continue;
        };
        let room_id = value
            .get("id")
            .and_then(|item| item.as_str())
            .map(ToString::to_string)
            .unwrap_or_else(|| {
                path.file_stem()
                    .and_then(|item| item.to_str())
                    .unwrap_or("chatroom")
                    .to_string()
            });
        let room_messages = value
            .get("messages")
            .and_then(|item| item.as_array())
            .cloned()
            .unwrap_or_default();
        for item in room_messages {
            messages.push(ChatRoomMessageRecord {
                id: item
                    .get("id")
                    .and_then(|value| value.as_str())
                    .unwrap_or("")
                    .to_string(),
                room_id: room_id.clone(),
                role: item
                    .get("role")
                    .and_then(|value| value.as_str())
                    .unwrap_or("advisor")
                    .to_string(),
                advisor_id: item
                    .get("advisorId")
                    .or_else(|| item.get("advisor_id"))
                    .and_then(|value| value.as_str())
                    .map(ToString::to_string),
                advisor_name: item
                    .get("advisorName")
                    .or_else(|| item.get("advisor_name"))
                    .and_then(|value| value.as_str())
                    .map(ToString::to_string),
                advisor_avatar: item
                    .get("advisorAvatar")
                    .or_else(|| item.get("advisor_avatar"))
                    .and_then(|value| value.as_str())
                    .map(ToString::to_string),
                content: item
                    .get("content")
                    .and_then(|value| value.as_str())
                    .unwrap_or("")
                    .to_string(),
                timestamp: item
                    .get("timestamp")
                    .and_then(|value| value.as_str())
                    .unwrap_or("0")
                    .to_string(),
                is_streaming: item
                    .get("isStreaming")
                    .or_else(|| item.get("is_streaming"))
                    .and_then(|value| value.as_bool()),
                phase: item
                    .get("phase")
                    .and_then(|value| value.as_str())
                    .map(ToString::to_string),
            });
        }
    }
    messages.sort_by(|a, b| a.timestamp.cmp(&b.timestamp));
    messages
}

pub(crate) fn load_memories_from_fs(memory_root: &Path) -> Vec<UserMemoryRecord> {
    read_json_file(&memory_root.join("catalog.json"))
        .and_then(|value| {
            value
                .get("memories")
                .and_then(|item| item.as_array())
                .cloned()
        })
        .unwrap_or_default()
        .into_iter()
        .filter_map(|item| serde_json::from_value::<UserMemoryRecord>(item).ok())
        .collect()
}

pub(crate) fn load_memory_history_from_fs(memory_root: &Path) -> Vec<MemoryHistoryRecord> {
    read_json_file(&memory_root.join("history.json"))
        .and_then(|value| value.get("items").and_then(|item| item.as_array()).cloned())
        .unwrap_or_default()
        .into_iter()
        .filter_map(|item| serde_json::from_value::<MemoryHistoryRecord>(item).ok())
        .collect()
}

pub(crate) fn load_media_assets_from_fs(media_root: &Path) -> Vec<MediaAssetRecord> {
    read_json_file(&media_root.join("catalog.json"))
        .and_then(|value| {
            value
                .get("assets")
                .and_then(|item| item.as_array())
                .cloned()
        })
        .unwrap_or_default()
        .into_iter()
        .filter_map(|item| {
            let relative_path = item
                .get("relativePath")
                .or_else(|| item.get("relative_path"))
                .and_then(|v| v.as_str())
                .map(ToString::to_string);
            let absolute_path = relative_path.as_ref().map(|rel| {
                normalize_legacy_workspace_path(&media_root.join(rel))
                    .display()
                    .to_string()
            });
            Some(MediaAssetRecord {
                id: item.get("id")?.as_str()?.to_string(),
                source: item
                    .get("source")
                    .and_then(|v| v.as_str())
                    .unwrap_or("imported")
                    .to_string(),
                source_domain: item
                    .get("sourceDomain")
                    .or_else(|| item.get("source_domain"))
                    .and_then(|v| v.as_str())
                    .map(ToString::to_string)
                    .or_else(|| {
                        item.get("sourceLink")
                            .or_else(|| item.get("source_link"))
                            .and_then(|v| v.as_str())
                            .and_then(|value| source_domain_from_link(Some(value)))
                    }),
                source_link: item
                    .get("sourceLink")
                    .or_else(|| item.get("source_link"))
                    .or_else(|| item.get("sourceUrl"))
                    .or_else(|| item.get("source_url"))
                    .and_then(|v| v.as_str())
                    .map(ToString::to_string),
                project_id: item
                    .get("projectId")
                    .or_else(|| item.get("project_id"))
                    .and_then(|v| v.as_str())
                    .map(ToString::to_string),
                title: item
                    .get("title")
                    .and_then(|v| v.as_str())
                    .map(ToString::to_string),
                prompt: item
                    .get("prompt")
                    .and_then(|v| v.as_str())
                    .map(ToString::to_string),
                provider: item
                    .get("provider")
                    .and_then(|v| v.as_str())
                    .map(ToString::to_string),
                provider_template: item
                    .get("providerTemplate")
                    .or_else(|| item.get("provider_template"))
                    .and_then(|v| v.as_str())
                    .map(ToString::to_string),
                model: item
                    .get("model")
                    .and_then(|v| v.as_str())
                    .map(ToString::to_string),
                aspect_ratio: item
                    .get("aspectRatio")
                    .or_else(|| item.get("aspect_ratio"))
                    .and_then(|v| v.as_str())
                    .map(ToString::to_string),
                size: item
                    .get("size")
                    .and_then(|v| v.as_str())
                    .map(ToString::to_string),
                quality: item
                    .get("quality")
                    .and_then(|v| v.as_str())
                    .map(ToString::to_string),
                mime_type: item
                    .get("mimeType")
                    .or_else(|| item.get("mime_type"))
                    .and_then(|v| v.as_str())
                    .map(ToString::to_string),
                relative_path: relative_path.clone(),
                bound_manuscript_path: item
                    .get("boundManuscriptPath")
                    .or_else(|| item.get("bound_manuscript_path"))
                    .and_then(|v| v.as_str())
                    .map(ToString::to_string),
                created_at: item
                    .get("createdAt")
                    .or_else(|| item.get("created_at"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("0")
                    .to_string(),
                updated_at: item
                    .get("updatedAt")
                    .or_else(|| item.get("updated_at"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("0")
                    .to_string(),
                absolute_path: absolute_path.clone(),
                preview_url: absolute_path
                    .as_ref()
                    .map(|abs| file_url_for_path(Path::new(abs))),
                exists: absolute_path
                    .as_ref()
                    .is_some_and(|abs| Path::new(abs).exists()),
            })
        })
        .collect()
}

pub(crate) fn load_cover_assets_from_fs(cover_root: &Path) -> Vec<CoverAssetRecord> {
    read_json_file(&cover_root.join("catalog.json"))
        .and_then(|value| {
            value
                .get("assets")
                .and_then(|item| item.as_array())
                .cloned()
        })
        .unwrap_or_default()
        .into_iter()
        .filter_map(|item| {
            let relative_path = item
                .get("relativePath")
                .or_else(|| item.get("relative_path"))
                .and_then(|v| v.as_str())
                .map(ToString::to_string);
            let absolute_path = relative_path.as_ref().map(|rel| {
                normalize_legacy_workspace_path(&cover_root.join(rel))
                    .display()
                    .to_string()
            });
            Some(CoverAssetRecord {
                id: item.get("id")?.as_str()?.to_string(),
                title: item
                    .get("title")
                    .and_then(|v| v.as_str())
                    .map(ToString::to_string),
                template_name: item
                    .get("templateName")
                    .or_else(|| item.get("template_name"))
                    .and_then(|v| v.as_str())
                    .map(ToString::to_string),
                prompt: item
                    .get("prompt")
                    .and_then(|v| v.as_str())
                    .map(ToString::to_string),
                provider: item
                    .get("provider")
                    .and_then(|v| v.as_str())
                    .map(ToString::to_string),
                provider_template: item
                    .get("providerTemplate")
                    .or_else(|| item.get("provider_template"))
                    .and_then(|v| v.as_str())
                    .map(ToString::to_string),
                model: item
                    .get("model")
                    .and_then(|v| v.as_str())
                    .map(ToString::to_string),
                aspect_ratio: item
                    .get("aspectRatio")
                    .or_else(|| item.get("aspect_ratio"))
                    .and_then(|v| v.as_str())
                    .map(ToString::to_string),
                size: item
                    .get("size")
                    .and_then(|v| v.as_str())
                    .map(ToString::to_string),
                quality: item
                    .get("quality")
                    .and_then(|v| v.as_str())
                    .map(ToString::to_string),
                relative_path: relative_path.clone(),
                preview_url: absolute_path
                    .as_ref()
                    .map(|abs| file_url_for_path(Path::new(abs))),
                exists: absolute_path
                    .as_ref()
                    .is_some_and(|abs| Path::new(abs).exists()),
                updated_at: item
                    .get("updatedAt")
                    .or_else(|| item.get("updated_at"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("0")
                    .to_string(),
            })
        })
        .collect()
}

pub(crate) fn load_knowledge_notes_from_fs(knowledge_root: &Path) -> Vec<KnowledgeNoteRecord> {
    let mut notes = Vec::new();
    let redbook_root = knowledge_root.join("redbook");
    if let Ok(entries) = fs::read_dir(&redbook_root) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let Some(meta) = read_json_file(&path.join("meta.json")) else {
                continue;
            };
            let entry_name = entry.file_name().to_string_lossy().to_string();
            let note_id = meta
                .get("id")
                .and_then(|v| v.as_str())
                .unwrap_or(&entry_name)
                .to_string();
            let content_path = path.join("content.md");
            let html_path = path.join("content.html");
            let content_text = meta
                .get("content")
                .and_then(|v| v.as_str())
                .map(ToString::to_string)
                .unwrap_or_else(|| read_text_file_or_empty(&content_path));
            let video_url = meta_string(
                &meta,
                &[
                    "videoUrl",
                    "video_url",
                    "sourceVideoUrl",
                    "source_video_url",
                ],
            );
            let video_asset_url = note_video_asset_url(&path, &meta).or_else(|| video_url.clone());
            let transcript = read_note_transcript(&path, &meta);
            let image_urls = meta
                .get("images")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|item| optional_note_asset_url(&path, Some(item)))
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            let cover_url = optional_note_asset_url(&path, meta.get("cover"))
                .or_else(|| {
                    let candidate = path.join("images").join("cover.jpg");
                    if candidate.exists() {
                        Some(file_url_for_path(&candidate))
                    } else {
                        None
                    }
                })
                .or_else(|| image_urls.first().cloned());
            let tags = meta
                .get("tags")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|x| x.as_str().map(ToString::to_string))
                        .collect::<Vec<_>>()
                })
                .filter(|arr| !arr.is_empty())
                .or_else(|| {
                    let extracted = extract_tags_from_text(&content_text);
                    if extracted.is_empty() {
                        None
                    } else {
                        Some(extracted)
                    }
                });
            let note_type = meta
                .get("type")
                .and_then(|v| v.as_str())
                .map(ToString::to_string);
            let capture_kind = meta
                .get("captureKind")
                .or_else(|| meta.get("capture_kind"))
                .and_then(|v| v.as_str())
                .map(ToString::to_string)
                .or_else(|| {
                    if note_type.as_deref() == Some("link-article") {
                        Some("link-article".to_string())
                    } else if video_asset_url.is_some() || video_url.is_some() {
                        Some("xhs-video".to_string())
                    } else if !image_urls.is_empty() {
                        Some("xhs-image".to_string())
                    } else {
                        None
                    }
                });
            notes.push(KnowledgeNoteRecord {
                id: note_id.clone(),
                r#type: note_type,
                source_domain: meta
                    .get("sourceDomain")
                    .or_else(|| meta.get("source_domain"))
                    .and_then(|v| v.as_str())
                    .map(ToString::to_string)
                    .or_else(|| {
                        meta.get("sourceLink")
                            .or_else(|| meta.get("source_link"))
                            .or_else(|| meta.get("sourceUrl"))
                            .or_else(|| meta.get("source_url"))
                            .or_else(|| meta.get("source"))
                            .or_else(|| meta.get("url"))
                            .and_then(|v| v.as_str())
                            .and_then(|value| source_domain_from_link(Some(value)))
                    }),
                source_link: meta
                    .get("sourceLink")
                    .or_else(|| meta.get("source_link"))
                    .or_else(|| meta.get("sourceUrl"))
                    .or_else(|| meta.get("source_url"))
                    .or_else(|| meta.get("source"))
                    .or_else(|| meta.get("url"))
                    .and_then(|v| v.as_str())
                    .map(ToString::to_string),
                source_url: meta
                    .get("sourceUrl")
                    .or_else(|| meta.get("source_url"))
                    .or_else(|| meta.get("sourceLink"))
                    .or_else(|| meta.get("source_link"))
                    .or_else(|| meta.get("source"))
                    .or_else(|| meta.get("url"))
                    .and_then(|v| v.as_str())
                    .map(ToString::to_string),
                title: meta
                    .get("title")
                    .and_then(|v| v.as_str())
                    .unwrap_or(&note_id)
                    .to_string(),
                author: meta
                    .get("author")
                    .and_then(|v| v.as_str())
                    .unwrap_or("原文链接")
                    .to_string(),
                content: content_text,
                excerpt: meta
                    .get("excerpt")
                    .and_then(|v| v.as_str())
                    .map(ToString::to_string),
                site_name: meta
                    .get("siteName")
                    .or_else(|| meta.get("site_name"))
                    .and_then(|v| v.as_str())
                    .map(ToString::to_string),
                capture_kind,
                html_file: if html_path.exists() {
                    Some(html_path.display().to_string())
                } else {
                    None
                },
                html_file_url: if html_path.exists() {
                    Some(file_url_for_path(&html_path))
                } else {
                    None
                },
                images: image_urls,
                tags,
                cover: cover_url,
                video: video_asset_url,
                video_url: video_url.clone(),
                transcript: transcript.clone(),
                transcription_status: meta
                    .get("transcriptionStatus")
                    .or_else(|| meta.get("transcription_status"))
                    .and_then(|v| v.as_str())
                    .map(ToString::to_string)
                    .or_else(|| transcript.as_ref().map(|_| "completed".to_string())),
                stats: KnowledgeNoteStatsRecord {
                    likes: extract_note_stat(&meta, "likes").unwrap_or(0),
                    collects: extract_note_stat(&meta, "collects"),
                },
                created_at: meta
                    .get("createdAt")
                    .or_else(|| meta.get("created_at"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("0")
                    .to_string(),
                folder_path: Some(path.display().to_string()),
            });
        }
    }
    notes.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    notes
}

pub(crate) fn load_youtube_videos_from_fs(knowledge_root: &Path) -> Vec<YoutubeVideoRecord> {
    let mut videos = Vec::new();
    let youtube_root = knowledge_root.join("youtube");
    if let Ok(entries) = fs::read_dir(&youtube_root) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let Some(meta) = read_json_file(&path.join("meta.json")) else {
                continue;
            };
            let subtitle_file = meta
                .get("subtitleFile")
                .or_else(|| meta.get("subtitle_file"))
                .and_then(|v| v.as_str())
                .map(ToString::to_string);
            let subtitle_content = subtitle_file
                .as_ref()
                .map(|rel| read_text_file_or_empty(&path.join(rel)))
                .filter(|text| !text.trim().is_empty());
            videos.push(YoutubeVideoRecord {
                id: {
                    let entry_name = entry.file_name().to_string_lossy().to_string();
                    meta.get("id")
                        .and_then(|v| v.as_str())
                        .unwrap_or(&entry_name)
                        .to_string()
                },
                video_id: meta
                    .get("videoId")
                    .or_else(|| meta.get("video_id"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                video_url: meta
                    .get("videoUrl")
                    .or_else(|| meta.get("video_url"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                title: meta
                    .get("title")
                    .and_then(|v| v.as_str())
                    .unwrap_or("YouTube 视频")
                    .to_string(),
                original_title: meta
                    .get("originalTitle")
                    .or_else(|| meta.get("original_title"))
                    .and_then(|v| v.as_str())
                    .map(ToString::to_string),
                description: meta
                    .get("description")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                summary: meta
                    .get("summary")
                    .and_then(|v| v.as_str())
                    .map(ToString::to_string),
                thumbnail_url: meta
                    .get("thumbnailUrl")
                    .or_else(|| meta.get("thumbnail_url"))
                    .and_then(|v| v.as_str())
                    .map(ToString::to_string)
                    .unwrap_or_else(|| {
                        let thumb = path.join("thumbnail.jpg");
                        if thumb.exists() {
                            file_url_for_path(&thumb)
                        } else {
                            String::new()
                        }
                    }),
                has_subtitle: meta
                    .get("hasSubtitle")
                    .or_else(|| meta.get("has_subtitle"))
                    .and_then(|v| v.as_bool())
                    .unwrap_or(subtitle_content.is_some()),
                subtitle_content,
                status: meta
                    .get("status")
                    .and_then(|v| v.as_str())
                    .map(ToString::to_string),
                created_at: meta
                    .get("createdAt")
                    .or_else(|| meta.get("created_at"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("0")
                    .to_string(),
                folder_path: Some(path.display().to_string()),
            });
        }
    }
    videos.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    videos
}

pub(crate) fn load_document_sources_from_fs(
    knowledge_root: &Path,
) -> Vec<DocumentKnowledgeSourceRecord> {
    let docs_root = knowledge_root.join("docs");
    let from_index = read_json_file(&docs_root.join("sources.json"))
        .and_then(|value| {
            value
                .as_array()
                .cloned()
                .or_else(|| value.get("sources").and_then(|v| v.as_array()).cloned())
        })
        .unwrap_or_default()
        .into_iter()
        .filter_map(|item| {
            Some(DocumentKnowledgeSourceRecord {
                id: item.get("id")?.as_str()?.to_string(),
                kind: item
                    .get("kind")
                    .and_then(|v| v.as_str())
                    .unwrap_or("docs")
                    .to_string(),
                name: item
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("文档源")
                    .to_string(),
                root_path: item
                    .get("rootPath")
                    .or_else(|| item.get("root_path"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                locked: item
                    .get("locked")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false),
                indexing: item
                    .get("indexing")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false),
                index_error: item
                    .get("indexError")
                    .or_else(|| item.get("index_error"))
                    .and_then(|v| v.as_str())
                    .map(ToString::to_string),
                file_count: item
                    .get("fileCount")
                    .or_else(|| item.get("file_count"))
                    .and_then(|v| v.as_i64())
                    .unwrap_or(0),
                sample_files: item
                    .get("sampleFiles")
                    .or_else(|| item.get("sample_files"))
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|x| x.as_str().map(ToString::to_string))
                            .collect()
                    })
                    .unwrap_or_default(),
                created_at: item
                    .get("createdAt")
                    .or_else(|| item.get("created_at"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("0")
                    .to_string(),
                updated_at: item
                    .get("updatedAt")
                    .or_else(|| item.get("updated_at"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("0")
                    .to_string(),
            })
        })
        .collect::<Vec<_>>();
    if !from_index.is_empty() {
        return from_index;
    }
    let imported_root = docs_root.join("imported");
    let mut items = Vec::new();
    if let Ok(entries) = fs::read_dir(&imported_root) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            items.push(DocumentKnowledgeSourceRecord {
                id: slug_from_relative_path(&name),
                kind: "docs".to_string(),
                name: name.clone(),
                root_path: path.display().to_string(),
                locked: false,
                indexing: false,
                index_error: None,
                file_count: fs::read_dir(&path)
                    .ok()
                    .map(|it| it.count() as i64)
                    .unwrap_or(0),
                sample_files: list_files_relative(&path, 8),
                created_at: now_iso(),
                updated_at: now_iso(),
            });
        }
    }
    items
}

pub(crate) fn load_redclaw_state_from_fs(redclaw_root: &Path) -> RedclawStateRecord {
    let mut state = RedclawStateRecord::default();
    if let Some(config) = read_json_file(&redclaw_root.join("background-runner.json")) {
        state.enabled = config
            .get("enabled")
            .and_then(|v| v.as_bool())
            .unwrap_or(state.enabled);
        state.interval_minutes = config
            .get("intervalMinutes")
            .or_else(|| config.get("interval_minutes"))
            .and_then(|v| v.as_i64())
            .unwrap_or(state.interval_minutes);
        state.keep_alive_when_no_window = config
            .get("keepAliveWhenNoWindow")
            .or_else(|| config.get("keep_alive_when_no_window"))
            .and_then(|v| v.as_bool())
            .unwrap_or(state.keep_alive_when_no_window);
        state.max_projects_per_tick = config
            .get("maxProjectsPerTick")
            .or_else(|| config.get("max_projects_per_tick"))
            .and_then(|v| v.as_i64())
            .unwrap_or(state.max_projects_per_tick);
        state.max_automation_per_tick = config
            .get("maxAutomationPerTick")
            .or_else(|| config.get("max_automation_per_tick"))
            .and_then(|v| v.as_i64())
            .unwrap_or(state.max_automation_per_tick);
        state.heartbeat = config
            .get("heartbeat")
            .cloned()
            .unwrap_or_else(|| state.heartbeat.clone());
        state.last_tick_at = config
            .get("lastTickAt")
            .or_else(|| config.get("last_tick_at"))
            .and_then(|v| v.as_str())
            .map(ToString::to_string);
        state.next_tick_at = config
            .get("nextTickAt")
            .or_else(|| config.get("next_tick_at"))
            .and_then(|v| v.as_str())
            .map(ToString::to_string);
        state.scheduled_tasks = config
            .get("scheduledTasks")
            .or_else(|| config.get("scheduled_tasks"))
            .and_then(|v| v.as_object())
            .map(|obj| {
                obj.values()
                    .filter_map(|item| {
                        Some(RedclawScheduledTaskRecord {
                            id: item.get("id")?.as_str()?.to_string(),
                            name: item
                                .get("name")
                                .and_then(|v| v.as_str())
                                .unwrap_or("未命名任务")
                                .to_string(),
                            enabled: item
                                .get("enabled")
                                .and_then(|v| v.as_bool())
                                .unwrap_or(true),
                            mode: item
                                .get("mode")
                                .and_then(|v| v.as_str())
                                .unwrap_or("interval")
                                .to_string(),
                            prompt: item
                                .get("prompt")
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string(),
                            project_id: item
                                .get("projectId")
                                .or_else(|| item.get("project_id"))
                                .and_then(|v| v.as_str())
                                .map(ToString::to_string),
                            interval_minutes: item
                                .get("intervalMinutes")
                                .or_else(|| item.get("interval_minutes"))
                                .and_then(|v| v.as_i64()),
                            time: item
                                .get("time")
                                .and_then(|v| v.as_str())
                                .map(ToString::to_string),
                            weekdays: item
                                .get("weekdays")
                                .and_then(|v| v.as_array())
                                .map(|arr| arr.iter().filter_map(|x| x.as_i64()).collect()),
                            run_at: item
                                .get("runAt")
                                .or_else(|| item.get("run_at"))
                                .and_then(|v| v.as_str())
                                .map(ToString::to_string),
                            created_at: item
                                .get("createdAt")
                                .or_else(|| item.get("created_at"))
                                .and_then(|v| v.as_str())
                                .unwrap_or("0")
                                .to_string(),
                            updated_at: item
                                .get("updatedAt")
                                .or_else(|| item.get("updated_at"))
                                .and_then(|v| v.as_str())
                                .unwrap_or("0")
                                .to_string(),
                            last_run_at: item
                                .get("lastRunAt")
                                .or_else(|| item.get("last_run_at"))
                                .and_then(|v| v.as_str())
                                .map(ToString::to_string),
                            last_result: item
                                .get("lastResult")
                                .or_else(|| item.get("last_result"))
                                .and_then(|v| v.as_str())
                                .map(ToString::to_string),
                            last_error: item
                                .get("lastError")
                                .or_else(|| item.get("last_error"))
                                .and_then(|v| v.as_str())
                                .map(ToString::to_string),
                            next_run_at: item
                                .get("nextRunAt")
                                .or_else(|| item.get("next_run_at"))
                                .and_then(|v| v.as_str())
                                .map(ToString::to_string),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
        state.long_cycle_tasks = config
            .get("longCycleTasks")
            .or_else(|| config.get("long_cycle_tasks"))
            .and_then(|v| v.as_object())
            .map(|obj| {
                obj.values()
                    .filter_map(|item| {
                        Some(RedclawLongCycleTaskRecord {
                            id: item.get("id")?.as_str()?.to_string(),
                            name: item
                                .get("name")
                                .and_then(|v| v.as_str())
                                .unwrap_or("未命名长周期任务")
                                .to_string(),
                            enabled: item
                                .get("enabled")
                                .and_then(|v| v.as_bool())
                                .unwrap_or(true),
                            status: item
                                .get("status")
                                .and_then(|v| v.as_str())
                                .unwrap_or("paused")
                                .to_string(),
                            objective: item
                                .get("objective")
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string(),
                            step_prompt: item
                                .get("stepPrompt")
                                .or_else(|| item.get("step_prompt"))
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string(),
                            project_id: item
                                .get("projectId")
                                .or_else(|| item.get("project_id"))
                                .and_then(|v| v.as_str())
                                .map(ToString::to_string),
                            interval_minutes: item
                                .get("intervalMinutes")
                                .or_else(|| item.get("interval_minutes"))
                                .and_then(|v| v.as_i64())
                                .unwrap_or(1440),
                            total_rounds: item
                                .get("totalRounds")
                                .or_else(|| item.get("total_rounds"))
                                .and_then(|v| v.as_i64())
                                .unwrap_or(1),
                            completed_rounds: item
                                .get("completedRounds")
                                .or_else(|| item.get("completed_rounds"))
                                .and_then(|v| v.as_i64())
                                .unwrap_or(0),
                            created_at: item
                                .get("createdAt")
                                .or_else(|| item.get("created_at"))
                                .and_then(|v| v.as_str())
                                .unwrap_or("0")
                                .to_string(),
                            updated_at: item
                                .get("updatedAt")
                                .or_else(|| item.get("updated_at"))
                                .and_then(|v| v.as_str())
                                .unwrap_or("0")
                                .to_string(),
                            last_run_at: item
                                .get("lastRunAt")
                                .or_else(|| item.get("last_run_at"))
                                .and_then(|v| v.as_str())
                                .map(ToString::to_string),
                            last_result: item
                                .get("lastResult")
                                .or_else(|| item.get("last_result"))
                                .and_then(|v| v.as_str())
                                .map(ToString::to_string),
                            last_error: item
                                .get("lastError")
                                .or_else(|| item.get("last_error"))
                                .and_then(|v| v.as_str())
                                .map(ToString::to_string),
                            next_run_at: item
                                .get("nextRunAt")
                                .or_else(|| item.get("next_run_at"))
                                .and_then(|v| v.as_str())
                                .map(ToString::to_string),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
    }
    state.projects = Vec::new();
    state
}

pub(crate) fn load_work_items_from_fs(redclaw_root: &Path) -> Vec<WorkItemRecord> {
    let mut items = Vec::new();
    let work_root = redclaw_root.join("work-items");
    if let Ok(entries) = fs::read_dir(&work_root) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() || path.extension().and_then(|v| v.to_str()) != Some("json") {
                continue;
            }
            let Some(item) = read_json_file(&path) else {
                continue;
            };
            items.push(WorkItemRecord {
                id: {
                    let entry_name = entry.file_name().to_string_lossy().to_string();
                    item.get("id")
                        .and_then(|v| v.as_str())
                        .unwrap_or(&entry_name)
                        .to_string()
                },
                title: item
                    .get("title")
                    .and_then(|v| v.as_str())
                    .unwrap_or("未命名工作项")
                    .to_string(),
                description: item
                    .get("description")
                    .and_then(|v| v.as_str())
                    .map(ToString::to_string),
                summary: item
                    .get("summary")
                    .and_then(|v| v.as_str())
                    .map(ToString::to_string),
                status: item
                    .get("status")
                    .and_then(|v| v.as_str())
                    .unwrap_or("pending")
                    .to_string(),
                effective_status: item
                    .get("effectiveStatus")
                    .or_else(|| item.get("effective_status"))
                    .and_then(|v| v.as_str())
                    .unwrap_or_else(|| {
                        item.get("status")
                            .and_then(|v| v.as_str())
                            .unwrap_or("pending")
                    })
                    .to_string(),
                priority: item.get("priority").and_then(|v| v.as_i64()).unwrap_or(0),
                r#type: item
                    .get("type")
                    .and_then(|v| v.as_str())
                    .unwrap_or("task")
                    .to_string(),
                blocked_by: item
                    .get("dependsOn")
                    .or_else(|| item.get("blockedBy"))
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|x| x.as_str().map(ToString::to_string))
                            .collect()
                    })
                    .unwrap_or_default(),
                refs: WorkRefsRecord {
                    project_ids: item
                        .pointer("/refs/projectIds")
                        .and_then(|v| v.as_array())
                        .map(|arr| {
                            arr.iter()
                                .filter_map(|x| x.as_str().map(ToString::to_string))
                                .collect()
                        })
                        .unwrap_or_default(),
                    session_ids: item
                        .pointer("/refs/sessionIds")
                        .and_then(|v| v.as_array())
                        .map(|arr| {
                            arr.iter()
                                .filter_map(|x| x.as_str().map(ToString::to_string))
                                .collect()
                        })
                        .unwrap_or_default(),
                    task_ids: item
                        .pointer("/refs/taskIds")
                        .and_then(|v| v.as_array())
                        .map(|arr| {
                            arr.iter()
                                .filter_map(|x| x.as_str().map(ToString::to_string))
                                .collect()
                        })
                        .unwrap_or_default(),
                },
                metadata: item.get("metadata").cloned(),
                schedule: WorkScheduleRecord {
                    mode: item
                        .pointer("/schedule/mode")
                        .and_then(|v| v.as_str())
                        .unwrap_or("none")
                        .to_string(),
                    interval_minutes: item
                        .pointer("/schedule/intervalMinutes")
                        .or_else(|| item.pointer("/schedule/interval_minutes"))
                        .and_then(|v| v.as_i64()),
                    time: item
                        .pointer("/schedule/time")
                        .and_then(|v| v.as_str())
                        .map(ToString::to_string),
                    weekdays: item
                        .pointer("/schedule/weekdays")
                        .and_then(|v| v.as_array())
                        .map(|arr| arr.iter().filter_map(|x| x.as_i64()).collect()),
                    run_at: item
                        .pointer("/schedule/runAt")
                        .or_else(|| item.pointer("/schedule/run_at"))
                        .and_then(|v| v.as_str())
                        .map(ToString::to_string),
                    next_run_at: item
                        .pointer("/schedule/nextRunAt")
                        .or_else(|| item.pointer("/schedule/next_run_at"))
                        .and_then(|v| v.as_str())
                        .map(ToString::to_string),
                    completed_rounds: item
                        .pointer("/schedule/completedRounds")
                        .or_else(|| item.pointer("/schedule/completed_rounds"))
                        .and_then(|v| v.as_i64()),
                    total_rounds: item
                        .pointer("/schedule/totalRounds")
                        .or_else(|| item.pointer("/schedule/total_rounds"))
                        .and_then(|v| v.as_i64()),
                },
                created_at: item
                    .get("createdAt")
                    .or_else(|| item.get("created_at"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("0")
                    .to_string(),
                updated_at: item
                    .get("updatedAt")
                    .or_else(|| item.get("updated_at"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("0")
                    .to_string(),
                completed_at: item
                    .get("completedAt")
                    .or_else(|| item.get("completed_at"))
                    .and_then(|v| v.as_str())
                    .map(ToString::to_string),
            });
        }
    }
    items.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    items
}
