use crate::persistence::{with_store, with_store_mut};
use crate::{
    build_advisor_youtube_channel, detect_ytdlp, fetch_ytdlp_channel_info, now_iso,
    parse_youtube_channel, parse_ytdlp_videos, AdvisorVideoRecord, AppState,
};
use serde_json::{json, Value};
use tauri::State;

const YTDLP_DISABLED_MESSAGE: &str = "内置 yt-dlp 服务已移除。";

pub(crate) fn refresh_advisor_videos(
    state: &State<'_, AppState>,
    advisor_id: &str,
    limit: i64,
) -> Result<Value, String> {
    let channel = with_store(state, |store| {
        let Some(advisor) = store.advisors.iter().find(|item| item.id == advisor_id) else {
            return Ok(json!({ "success": false, "error": "成员不存在" }));
        };
        Ok(advisor.youtube_channel.clone().unwrap_or_else(|| {
            build_advisor_youtube_channel(None, "https://youtube.com/@redbox", "redbox")
        }))
    })?;
    if channel
        .get("success")
        .and_then(|value| value.as_bool())
        .is_some_and(|success| !success)
    {
        return Ok(channel);
    }
    let url = channel
        .get("url")
        .and_then(|value| value.as_str())
        .unwrap_or("https://youtube.com/@redbox");
    let (fallback_channel_id, fallback_channel_name) = parse_youtube_channel(url);
    let fetched = match detect_ytdlp() {
        Some(_) => fetch_ytdlp_channel_info(url, limit)
            .map_err(|error| format!("获取 YouTube 频道视频失败：{error}"))?,
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
    let next_videos = parse_ytdlp_videos(advisor_id, Some(&channel_id), &fetched);
    if next_videos.is_empty() {
        return Ok(json!({
            "success": false,
            "error": format!("未从 YouTube 频道 {} 获取到可下载的视频条目", channel_name)
        }));
    }
    with_store_mut(state, |store| {
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
        if let Some(advisor) = store.advisors.iter_mut().find(|item| item.id == advisor_id) {
            advisor.youtube_channel = Some(build_advisor_youtube_channel(
                Some(&channel),
                url,
                &channel_id,
            ));
            advisor.updated_at = now_iso();
        }
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
