use crate::persistence::{with_store, with_store_mut};
use crate::{
    advisor_knowledge_dir, download_ytdlp_subtitle, now_iso, payload_string,
    read_text_file_or_empty, slug_from_relative_path, AppState,
};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};

pub(super) fn download_video_value(
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

pub(super) fn retry_failed_value(
    app: &AppHandle,
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let advisor_id = payload_string(payload, "advisorId").unwrap_or_default();
    let knowledge_dir = advisor_knowledge_dir(state, &advisor_id)?;
    let failed_videos = with_store(state, |store| {
        Ok(store
            .advisor_videos
            .iter()
            .filter(|item| item.advisor_id == advisor_id && item.status == "failed")
            .cloned()
            .collect::<Vec<_>>())
    })?;
    let mut success_count = 0_i64;
    let mut fail_count = 0_i64;
    for video in failed_videos {
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
                with_store_mut(state, |store| {
                    if let Some(video) = store
                        .advisor_videos
                        .iter_mut()
                        .find(|item| item.id == video.id && item.advisor_id == advisor_id)
                    {
                        video.status = "success".to_string();
                        video.subtitle_file = Some(subtitle_name.clone());
                        video.error_message = None;
                        video.retry_count += 1;
                        video.updated_at = now_iso();
                    }
                    Ok(())
                })?;
                success_count += 1;
            }
            Err(error) => {
                with_store_mut(state, |store| {
                    if let Some(video) = store
                        .advisor_videos
                        .iter_mut()
                        .find(|item| item.id == video.id && item.advisor_id == advisor_id)
                    {
                        video.retry_count += 1;
                        video.error_message = Some(error.to_string());
                    }
                    Ok(())
                })?;
                fail_count += 1;
            }
        }
    }
    let result = json!({ "success": true, "successCount": success_count, "failCount": fail_count });
    let _ = app.emit("advisors:changed", json!({ "advisorId": advisor_id }));
    Ok(result)
}
