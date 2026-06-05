use crate::persistence::with_store_mut;
use crate::{
    build_advisor_youtube_channel, make_id, now_iso, read_text_file_or_empty, AdvisorVideoRecord,
    AppState, YoutubeVideoRecord,
};
use std::path::Path;
use tauri::State;

pub(super) fn upsert_failed_advisor_video(
    state: &State<'_, AppState>,
    advisor_id: &str,
    channel_id: &str,
    video: &AdvisorVideoRecord,
    error: &str,
) -> Result<(), String> {
    with_store_mut(state, |store| {
        if let Some(existing) = store
            .advisor_videos
            .iter_mut()
            .find(|item| item.id == video.id && item.advisor_id == advisor_id)
        {
            existing.title = video.title.clone();
            existing.published_at = video.published_at.clone();
            existing.video_url = video.video_url.clone();
            existing.status = "failed".to_string();
            existing.error_message = Some(error.to_string());
            existing.updated_at = now_iso();
        } else {
            store.advisor_videos.push(AdvisorVideoRecord {
                id: video.id.clone(),
                advisor_id: advisor_id.to_string(),
                title: video.title.clone(),
                published_at: video.published_at.clone(),
                status: "failed".to_string(),
                retry_count: 0,
                error_message: Some(error.to_string()),
                subtitle_file: None,
                video_url: video.video_url.clone(),
                channel_id: Some(channel_id.to_string()),
                created_at: now_iso(),
                updated_at: now_iso(),
            });
        }
        Ok(())
    })
}

pub(super) fn persist_successful_download(
    state: &State<'_, AppState>,
    advisor_id: &str,
    channel_url: &str,
    channel_id: &str,
    channel_name: &str,
    knowledge_dir: &Path,
    video: &AdvisorVideoRecord,
    subtitle_path: &Path,
) -> Result<(), String> {
    let subtitle_name = subtitle_path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("subtitle.txt")
        .to_string();
    let subtitle_content = read_text_file_or_empty(subtitle_path);
    with_store_mut(state, |store| {
        if let Some(advisor) = store.advisors.iter_mut().find(|item| item.id == advisor_id) {
            advisor.youtube_channel = Some(build_advisor_youtube_channel(
                advisor.youtube_channel.as_ref(),
                channel_url,
                channel_id,
            ));
            if !advisor.knowledge_files.contains(&subtitle_name) {
                advisor.knowledge_files.push(subtitle_name.clone());
            }
            advisor.updated_at = now_iso();
        }
        if let Some(existing) = store
            .advisor_videos
            .iter_mut()
            .find(|item| item.id == video.id && item.advisor_id == advisor_id)
        {
            existing.title = video.title.clone();
            existing.published_at = video.published_at.clone();
            existing.video_url = video.video_url.clone();
            existing.status = "success".to_string();
            existing.subtitle_file = Some(subtitle_name.clone());
            existing.updated_at = now_iso();
            existing.error_message = None;
        } else {
            store.advisor_videos.push(AdvisorVideoRecord {
                id: video.id.clone(),
                advisor_id: advisor_id.to_string(),
                title: video.title.clone(),
                published_at: video.published_at.clone(),
                status: "success".to_string(),
                retry_count: 0,
                error_message: None,
                subtitle_file: Some(subtitle_name.clone()),
                video_url: video.video_url.clone(),
                channel_id: Some(channel_id.to_string()),
                created_at: now_iso(),
                updated_at: now_iso(),
            });
        }
        if !store
            .youtube_videos
            .iter()
            .any(|item| item.video_id == video.id)
        {
            store.youtube_videos.push(YoutubeVideoRecord {
                id: make_id("youtube"),
                video_id: video.id.clone(),
                video_url: video.video_url.clone().unwrap_or_else(|| {
                    format!("{}/videos/{}", channel_url.trim_end_matches('/'), video.id)
                }),
                title: video.title.clone(),
                original_title: None,
                description: format!("Imported from advisor channel {}", channel_name),
                summary: Some(
                    "RedBox imported this advisor video into the knowledge store.".to_string(),
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
            .find(|item| item.video_id == video.id)
        {
            existing.subtitle_content = Some(subtitle_content);
            existing.has_subtitle = true;
            existing.subtitle_error = None;
            existing.status = Some("completed".to_string());
        }
        Ok(())
    })
}
