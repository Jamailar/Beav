use crate::persistence::{ensure_store_hydrated_for_advisors, with_store, with_store_mut};
use crate::*;
use serde_json::{json, Value};
use std::fs;
use tauri::{AppHandle, Emitter, State};

#[path = "advisor_ops/crud.rs"]
mod crud;
#[path = "advisor_ops/knowledge_files.rs"]
mod knowledge_files;
#[path = "advisor_ops/member_skills.rs"]
mod member_skills;
#[path = "advisor_ops/persona.rs"]
mod persona;
#[path = "advisor_ops/prompt_ops.rs"]
mod prompt_ops;
#[path = "advisor_ops/templates.rs"]
mod templates;
#[path = "advisor_ops/videos.rs"]
mod videos;

use crud::handle_crud_channel;
use knowledge_files::{collect_advisor_knowledge_files, import_advisor_knowledge_files};
use member_skills::{handle_member_skill_channel, publish_member_skill_if_enabled};
use persona::handle_persona_channel;
use prompt_ops::handle_prompt_channel;
pub(crate) use templates::advisors_list_templates_value;
use videos::refresh_advisor_videos;

const YTDLP_DISABLED_MESSAGE: &str = "内置 yt-dlp 服务已移除。";

pub(crate) fn advisors_list_value(state: &State<'_, AppState>) -> Result<Value, String> {
    let _ = ensure_store_hydrated_for_advisors(state);
    with_store(state, |store| {
        let mut advisors = store.advisors.clone();
        advisors.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        Ok(json!(advisors))
    })
}

#[tauri::command]
pub async fn advisors_list(state: State<'_, AppState>) -> Result<Value, String> {
    advisors_list_value(&state)
}

#[tauri::command]
pub async fn advisors_list_templates() -> Result<Value, String> {
    advisors_list_templates_value()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn advisors_list_templates_loads_bundled_member_templates() {
        let templates = advisors_list_templates_value()
            .expect("advisor templates should load")
            .as_array()
            .cloned()
            .expect("advisor templates should be an array");
        let template_ids = templates
            .iter()
            .filter_map(|item| item.get("id").and_then(Value::as_str))
            .collect::<std::collections::BTreeSet<_>>();

        assert_eq!(templates.len(), 14);
        assert!(template_ids.contains("agency-xiaohongshu-specialist"));
        assert!(template_ids.contains("agency-product-manager"));
        assert!(template_ids.contains("content-strategist"));
        assert!(template_ids.contains("growth-analyst"));
    }
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
            | "advisors:list-templates"
            | "advisors:create"
            | "advisors:update"
            | "advisors:delete"
            | "advisors:pick-knowledge-files"
            | "advisors:pick-knowledge-folder"
            | "advisors:upload-knowledge"
            | "advisors:delete-knowledge"
            | "advisors:optimize-prompt"
            | "advisors:optimize-prompt-deep"
            | "advisors:generate-persona"
            | "advisors:inspect-member-skill"
            | "advisors:promote-member-skill-candidate"
            | "advisors:discard-member-skill-candidate"
            | "advisors:rollback-member-skill-version"
            | "members:enqueue-distillation"
            | "members:distill-skill"
            | "members:list-distillation-candidates"
            | "members:preview-distillation"
            | "members:approve-distillation"
            | "members:publish-skill-version"
            | "members:rollback-skill-version"
            | "members:compile-skill-package"
            | "members:evaluate-skill"
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
    ) {
        return None;
    }

    Some((|| -> Result<Value, String> {
        match channel {
            "advisors:list" => advisors_list_value(state),
            "advisors:list-templates" => advisors_list_templates_value(),
            "advisors:create" | "advisors:update" | "advisors:delete" => {
                handle_crud_channel(app, state, channel, payload)
                    .unwrap_or_else(|| Err("成员 CRUD 动作未注册".to_string()))
            }
            "advisors:pick-knowledge-files" => {
                let selected = pick_files_native("选择要导入该成员知识库的文件", false, true)?;
                let files = selected
                    .into_iter()
                    .map(|path| {
                        json!({
                            "path": path,
                            "name": path.file_name().and_then(|value| value.to_str()).unwrap_or_default()
                        })
                    })
                    .collect::<Vec<_>>();
                Ok(json!({ "success": true, "files": files }))
            }
            "advisors:pick-knowledge-folder" => {
                let selected = pick_files_native("选择要导入该成员知识库的文件夹", true, false)?;
                let files = collect_advisor_knowledge_files(&selected)?
                    .into_iter()
                    .map(|path| {
                        json!({
                            "path": path,
                            "name": path.file_name().and_then(|value| value.to_str()).unwrap_or_default()
                        })
                    })
                    .collect::<Vec<_>>();
                Ok(json!({ "success": true, "files": files }))
            }
            "advisors:upload-knowledge" => {
                let started_at = now_ms();
                let advisor_id = payload_string(payload, "advisorId")
                    .or_else(|| payload_value_as_string(payload))
                    .unwrap_or_default();
                let selected = payload_field(payload, "filePaths")
                    .and_then(|value| value.as_array())
                    .map(|items| {
                        items
                            .iter()
                            .filter_map(|item| item.as_str())
                            .map(std::path::PathBuf::from)
                            .collect::<Vec<_>>()
                    })
                    .map(Ok)
                    .unwrap_or_else(|| {
                        pick_files_native("选择要导入该成员知识库的文件", false, true)
                    })?;
                let imported = import_advisor_knowledge_files(state, &advisor_id, &selected)?;
                let imported_file_count = imported
                    .get("files")
                    .and_then(Value::as_array)
                    .map(|items| items.len() as i64)
                    .unwrap_or_default();
                let total_knowledge_file_count = with_store(state, |store| {
                    Ok(store
                        .advisors
                        .iter()
                        .find(|item| item.id == advisor_id)
                        .map(|item| item.knowledge_files.len() as i64)
                        .unwrap_or_default())
                })?;
                let _ = record_advisor_knowledge_ingest_metric(
                    state,
                    AdvisorKnowledgeIngestMetric {
                        advisor_id: advisor_id.clone(),
                        imported_file_count,
                        total_knowledge_file_count,
                        elapsed_ms: now_ms().saturating_sub(started_at) as i64,
                        created_at: now_i64(),
                    },
                );
                log_timing_event(
                    state,
                    "advisor",
                    &format!("advisors:upload-knowledge:{advisor_id}"),
                    "advisors:upload-knowledge",
                    started_at,
                    Some(format!(
                        "importedFiles={} totalKnowledgeFiles={}",
                        imported_file_count, total_knowledge_file_count
                    )),
                );
                let member_skill =
                    publish_member_skill_if_enabled(state, &advisor_id, "advisor-knowledge-import");
                let _ = app.emit("advisors:changed", json!({ "advisorId": advisor_id }));
                knowledge_index::jobs::schedule_rebuild(app, "advisor-knowledge-import");
                let mut imported = imported;
                if let Some(object) = imported.as_object_mut() {
                    object.insert(
                        "memberSkill".to_string(),
                        member_skill.unwrap_or_else(|| Value::Null),
                    );
                }
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
                let _ =
                    publish_member_skill_if_enabled(state, &advisor_id, "advisor-knowledge-delete");
                let _ = app.emit("advisors:changed", json!({ "advisorId": advisor_id }));
                knowledge_index::jobs::schedule_rebuild(app, "advisor-knowledge-delete");
                Ok(result)
            }
            "advisors:promote-member-skill-candidate"
            | "members:enqueue-distillation"
            | "members:distill-skill"
            | "members:approve-distillation"
            | "members:publish-skill-version"
            | "advisors:discard-member-skill-candidate"
            | "advisors:inspect-member-skill"
            | "members:list-distillation-candidates"
            | "members:preview-distillation"
            | "advisors:rollback-member-skill-version"
            | "members:rollback-skill-version"
            | "members:compile-skill-package"
            | "members:evaluate-skill" => handle_member_skill_channel(app, state, channel, payload)
                .unwrap_or_else(|| Err("成员技能动作未注册".to_string())),
            "advisors:optimize-prompt" | "advisors:optimize-prompt-deep" => {
                handle_prompt_channel(state, channel, payload)
                    .unwrap_or_else(|| Err("成员提示词动作未注册".to_string()))
            }
            "advisors:generate-persona" => handle_persona_channel(state, channel, payload)
                .unwrap_or_else(|| Err("成员角色生成动作未注册".to_string())),
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
                let fetched = match detect_ytdlp() {
                    Some(_) => match fetch_ytdlp_channel_info(&channel_url, 6) {
                        Ok(value) => value,
                        Err(error) => {
                            return Ok(json!({
                                "success": false,
                                "error": format!("获取 YouTube 频道信息失败：{error}")
                            }));
                        }
                    },
                    None => {
                        return Ok(json!({
                            "success": false,
                            "error": YTDLP_DISABLED_MESSAGE
                        }));
                    }
                };
                let channel_id = fetched
                    .get("channel_id")
                    .and_then(|item| item.as_str())
                    .map(|item| item.to_string())
                    .unwrap_or(fallback_channel_id);
                let channel_name = fetched
                    .get("channel")
                    .or_else(|| fetched.get("uploader"))
                    .or_else(|| fetched.get("title"))
                    .and_then(|item| item.as_str())
                    .map(|item| item.to_string())
                    .unwrap_or(fallback_channel_name);
                let channel_description = fetched
                    .get("description")
                    .and_then(|item| item.as_str())
                    .map(|item| item.to_string())
                    .unwrap_or_default();
                let avatar_url = fetched
                    .get("thumbnails")
                    .and_then(|item| item.as_array())
                    .and_then(|items| items.last())
                    .and_then(|item| item.get("url"))
                    .and_then(|item| item.as_str())
                    .unwrap_or("")
                    .to_string();
                let recent_videos = parse_ytdlp_videos("", Some(&channel_id), &fetched)
                    .into_iter()
                    .take(5)
                    .map(|video| json!({ "id": video.id, "title": video.title }))
                    .collect::<Vec<_>>();
                if recent_videos.is_empty() {
                    return Ok(json!({
                        "success": false,
                        "error": format!("未从 YouTube 频道 {} 获取到可下载的视频条目", channel_name)
                    }));
                }
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
                let fetched = match detect_ytdlp() {
                    Some(_) => match fetch_ytdlp_channel_info(&channel_url, count) {
                        Ok(value) => value,
                        Err(error) => {
                            return Ok(json!({
                                "success": false,
                                "successCount": 0,
                                "failCount": count,
                                "error": format!("获取 YouTube 频道视频失败：{error}")
                            }));
                        }
                    },
                    None => {
                        return Ok(json!({
                            "success": false,
                            "successCount": 0,
                            "failCount": count,
                            "error": YTDLP_DISABLED_MESSAGE
                        }));
                    }
                };
                let channel_id = fetched
                    .get("channel_id")
                    .and_then(|item| item.as_str())
                    .map(|item| item.to_string())
                    .unwrap_or(fallback_channel_id);
                let channel_name = fetched
                    .get("channel")
                    .or_else(|| fetched.get("uploader"))
                    .or_else(|| fetched.get("title"))
                    .and_then(|item| item.as_str())
                    .map(|item| item.to_string())
                    .unwrap_or(fallback_channel_name);
                let real_videos = parse_ytdlp_videos(&advisor_id, Some(&channel_id), &fetched);
                if real_videos.is_empty() {
                    return Ok(json!({
                        "success": false,
                        "successCount": 0,
                        "failCount": count,
                        "error": format!("未从 YouTube 频道 {} 获取到可下载的视频条目", channel_name)
                    }));
                }
                let knowledge_dir = advisor_knowledge_dir(state, &advisor_id)?;
                let mut success_count = 0_i64;
                let mut fail_count = 0_i64;
                for (index, video) in real_videos.into_iter().take(count as usize).enumerate() {
                    let _ = app.emit(
                        "advisors:download-progress",
                        json!({ "advisorId": advisor_id, "progress": format!("正在处理第 {} / {} 个视频...", index + 1, count) }),
                    );
                    let video_id = video.id.clone();
                    let Some(video_url) = video.video_url.clone() else {
                        fail_count += 1;
                        continue;
                    };
                    let subtitle_path = match download_ytdlp_subtitle(
                        &video_url,
                        &knowledge_dir,
                        &slug_from_relative_path(&video_id),
                    ) {
                        Ok(path) => path,
                        Err(error) => {
                            let video_title = video.title.clone();
                            let video_published_at = video.published_at.clone();
                            let video_url_saved = video.video_url.clone();
                            with_store_mut(state, |store| {
                                if let Some(video) = store.advisor_videos.iter_mut().find(|item| {
                                    item.id == video_id && item.advisor_id == advisor_id
                                }) {
                                    video.title = video_title.clone();
                                    video.published_at = video_published_at.clone();
                                    video.video_url = video_url_saved.clone();
                                    video.status = "failed".to_string();
                                    video.error_message = Some(error.clone());
                                    video.updated_at = now_iso();
                                } else {
                                    store.advisor_videos.push(AdvisorVideoRecord {
                                        id: video_id.clone(),
                                        advisor_id: advisor_id.clone(),
                                        title: video_title.clone(),
                                        published_at: video_published_at.clone(),
                                        status: "failed".to_string(),
                                        retry_count: 0,
                                        error_message: Some(error.clone()),
                                        subtitle_file: None,
                                        video_url: video_url_saved.clone(),
                                        channel_id: Some(channel_id.clone()),
                                        created_at: now_iso(),
                                        updated_at: now_iso(),
                                    });
                                }
                                Ok(())
                            })?;
                            fail_count += 1;
                            continue;
                        }
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
                                subtitle_error: None,
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
                            existing.subtitle_error = None;
                            existing.status = Some("completed".to_string());
                        }
                        Ok(())
                    })?;
                    success_count += 1;
                }
                let _ = app.emit(
                    "advisors:download-progress",
                    json!({ "advisorId": advisor_id, "progress": format!("下载完成：成功 {} 个，失败 {} 个", success_count, fail_count) }),
                );
                let member_skill =
                    publish_member_skill_if_enabled(state, &advisor_id, "advisor-youtube-import");
                let _ = app.emit("advisors:changed", json!({ "advisorId": advisor_id }));
                Ok(json!({
                    "success": fail_count == 0,
                    "successCount": success_count,
                    "failCount": fail_count,
                    "memberSkill": member_skill,
                    "error": if fail_count > 0 { Some(format!("{} 个视频字幕下载失败", fail_count)) } else { None }
                }))
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
                let video_snapshot = with_store(state, |store| {
                    Ok(store
                        .advisor_videos
                        .iter()
                        .find(|item| item.id == video_id && item.advisor_id == advisor_id)
                        .cloned())
                })?;
                let Some(video_snapshot) = video_snapshot else {
                    return Ok(json!({ "success": false, "error": "视频不存在" }));
                };
                let Some(video_url) = video_snapshot.video_url.clone() else {
                    return Ok(json!({ "success": false, "error": "视频缺少 YouTube URL" }));
                };
                let subtitle_result = download_ytdlp_subtitle(
                    &video_url,
                    &knowledge_dir,
                    &slug_from_relative_path(&video_snapshot.id),
                );
                let result =
                    match subtitle_result {
                        Ok(subtitle_path) => {
                            let subtitle_name = subtitle_path
                                .file_name()
                                .and_then(|value| value.to_str())
                                .unwrap_or("subtitle.txt")
                                .to_string();
                            let subtitle_content = read_text_file_or_empty(&subtitle_path);
                            with_store_mut(state, |store| {
                                if let Some(video) = store.advisor_videos.iter_mut().find(|item| {
                                    item.id == video_id && item.advisor_id == advisor_id
                                }) {
                                    video.status = "success".to_string();
                                    video.subtitle_file = Some(subtitle_name.clone());
                                    video.error_message = None;
                                    video.updated_at = now_iso();
                                }
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
                                    existing.subtitle_error = None;
                                    existing.status = Some("completed".to_string());
                                }
                                Ok(json!({ "success": true, "subtitleFile": subtitle_name }))
                            })?
                        }
                        Err(error) => {
                            with_store_mut(state, |store| {
                                if let Some(video) = store.advisor_videos.iter_mut().find(|item| {
                                    item.id == video_id && item.advisor_id == advisor_id
                                }) {
                                    video.status = "failed".to_string();
                                    video.error_message = Some(error.clone());
                                    video.updated_at = now_iso();
                                }
                                Ok(())
                            })?;
                            json!({ "success": false, "error": error })
                        }
                    };
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
            _ => unreachable!(),
        }
    })())
}
