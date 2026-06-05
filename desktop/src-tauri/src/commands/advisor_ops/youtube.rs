use super::member_skills::publish_member_skill_if_enabled;
use super::videos::refresh_advisor_videos;
#[path = "youtube_channel_info.rs"]
mod youtube_channel_info;
#[path = "youtube_persistence.rs"]
mod youtube_persistence;
use crate::persistence::{with_store, with_store_mut};
use crate::{
    advisor_knowledge_dir, build_advisor_youtube_channel, detect_ytdlp, download_ytdlp_subtitle,
    fetch_ytdlp_channel_info, now_iso, parse_youtube_channel, parse_ytdlp_videos, payload_field,
    payload_string, read_text_file_or_empty, slug_from_relative_path, AdvisorVideoRecord, AppState,
};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};
use youtube_channel_info::channel_info_from_ytdlp_payload;
use youtube_persistence::{persist_successful_download, upsert_failed_advisor_video};

const YTDLP_DISABLED_MESSAGE: &str = "内置 yt-dlp 服务已移除。";

pub(super) fn handle_youtube_channel(
    app: &AppHandle,
    state: &State<'_, AppState>,
    channel: &str,
    payload: &Value,
) -> Option<Result<Value, String>> {
    Some(match channel {
        "advisors:youtube-runner-status" => youtube_runner_status_value(state),
        "advisors:fetch-youtube-info" => fetch_youtube_info_value(payload),
        "advisors:download-youtube-subtitles" => {
            download_youtube_subtitles_value(app, state, payload)
        }
        "advisors:get-videos" => get_videos_value(state, payload),
        "advisors:refresh-videos" => refresh_videos_value(state, payload),
        "advisors:download-video" => download_video_value(app, state, payload),
        "advisors:retry-failed" => retry_failed_value(app, state, payload),
        "advisors:update-youtube-settings" => update_youtube_settings_value(state, payload),
        "advisors:youtube-runner-run-now" => youtube_runner_run_now_value(state, payload),
        _ => return None,
    })
}

fn youtube_runner_status_value(state: &State<'_, AppState>) -> Result<Value, String> {
    with_store(state, |store| {
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
    })
}

fn fetch_youtube_info_value(payload: &Value) -> Result<Value, String> {
    let channel_url = payload_string(payload, "channelUrl").unwrap_or_default();
    let (fallback_channel_id, fallback_channel_name) = parse_youtube_channel(&channel_url);
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
    let channel_info =
        channel_info_from_ytdlp_payload(&fetched, fallback_channel_id, fallback_channel_name);
    let recent_videos = parse_ytdlp_videos("", Some(&channel_info.channel_id), &fetched)
        .into_iter()
        .take(5)
        .map(|video| json!({ "id": video.id, "title": video.title }))
        .collect::<Vec<_>>();
    if recent_videos.is_empty() {
        return Ok(json!({
            "success": false,
            "error": format!("未从 YouTube 频道 {} 获取到可下载的视频条目", channel_info.channel_name)
        }));
    }
    Ok(json!({
        "success": true,
        "data": {
            "channelId": channel_info.channel_id,
            "channelName": channel_info.channel_name,
            "channelDescription": channel_info.description,
            "avatarUrl": channel_info.avatar_url,
            "recentVideos": recent_videos
        }
    }))
}

fn download_youtube_subtitles_value(
    app: &AppHandle,
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let advisor_id = payload_string(payload, "advisorId").unwrap_or_default();
    let channel_url = payload_string(payload, "channelUrl").unwrap_or_default();
    let count = payload_field(payload, "videoCount")
        .and_then(|value| value.as_i64())
        .unwrap_or(10)
        .max(1);
    let (fallback_channel_id, fallback_channel_name) = parse_youtube_channel(&channel_url);
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
    let channel_info =
        channel_info_from_ytdlp_payload(&fetched, fallback_channel_id, fallback_channel_name);
    let real_videos = parse_ytdlp_videos(&advisor_id, Some(&channel_info.channel_id), &fetched);
    if real_videos.is_empty() {
        return Ok(json!({
            "success": false,
            "successCount": 0,
            "failCount": count,
            "error": format!("未从 YouTube 频道 {} 获取到可下载的视频条目", channel_info.channel_name)
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
                upsert_failed_advisor_video(
                    state,
                    &advisor_id,
                    &channel_info.channel_id,
                    &video,
                    &error,
                )?;
                fail_count += 1;
                continue;
            }
        };
        persist_successful_download(
            state,
            &advisor_id,
            &channel_url,
            &channel_info.channel_id,
            &channel_info.channel_name,
            &knowledge_dir,
            &video,
            &subtitle_path,
        )?;
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

fn get_videos_value(state: &State<'_, AppState>, payload: &Value) -> Result<Value, String> {
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
        Ok(json!({ "success": true, "videos": videos, "youtubeChannel": youtube_channel }))
    })
}

fn refresh_videos_value(state: &State<'_, AppState>, payload: &Value) -> Result<Value, String> {
    let advisor_id = payload_string(payload, "advisorId").unwrap_or_default();
    let limit = payload_field(payload, "limit")
        .and_then(|value| value.as_i64())
        .unwrap_or(20)
        .max(1);
    refresh_advisor_videos(state, &advisor_id, limit)
}

fn download_video_value(
    app: &AppHandle,
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
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
    let result = match subtitle_result {
        Ok(subtitle_path) => {
            let subtitle_name = subtitle_path
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("subtitle.txt")
                .to_string();
            let subtitle_content = read_text_file_or_empty(&subtitle_path);
            with_store_mut(state, |store| {
                if let Some(video) = store
                    .advisor_videos
                    .iter_mut()
                    .find(|item| item.id == video_id && item.advisor_id == advisor_id)
                {
                    video.status = "success".to_string();
                    video.subtitle_file = Some(subtitle_name.clone());
                    video.error_message = None;
                    video.updated_at = now_iso();
                }
                if let Some(advisor) = store.advisors.iter_mut().find(|item| item.id == advisor_id)
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
                if let Some(video) = store
                    .advisor_videos
                    .iter_mut()
                    .find(|item| item.id == video_id && item.advisor_id == advisor_id)
                {
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

fn retry_failed_value(
    app: &AppHandle,
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
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
            match subtitle_result.unwrap_or_else(|| Err("missing video url".to_string())) {
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
        Ok(json!({ "success": true, "successCount": success_count, "failCount": fail_count }))
    })?;
    let _ = app.emit("advisors:changed", json!({ "advisorId": advisor_id }));
    Ok(result)
}

fn update_youtube_settings_value(
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let advisor_id = payload_string(payload, "advisorId").unwrap_or_default();
    let settings_patch = payload_field(payload, "settings")
        .cloned()
        .unwrap_or_else(|| json!({}));
    with_store_mut(state, |store| {
        let Some(advisor) = store.advisors.iter_mut().find(|item| item.id == advisor_id) else {
            return Ok(json!({ "success": false, "error": "成员不存在" }));
        };
        let mut channel = advisor
            .youtube_channel
            .clone()
            .unwrap_or_else(|| {
                build_advisor_youtube_channel(None, "https://youtube.com/@redbox", "redbox")
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
    })
}

fn youtube_runner_run_now_value(
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
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
