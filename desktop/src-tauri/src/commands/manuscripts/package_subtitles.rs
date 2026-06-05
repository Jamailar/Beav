use super::subtitles::{
    build_fallback_srt_segments, parse_srt_segments, serialize_srt_segments, SrtSegment,
};
use super::*;
use crate::store::settings as settings_store;

pub(super) fn transcribe_package_subtitles_value(
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let file_path = payload_string(payload, "filePath").unwrap_or_default();
    let source_item_id = payload_string(payload, "clipId")
        .or_else(|| payload_string(payload, "itemId"))
        .unwrap_or_default();
    if file_path.is_empty() || source_item_id.is_empty() {
        return Ok(json!({
            "success": false,
            "error": "filePath and clipId are required"
        }));
    }
    let full_path = resolve_manuscript_path(state, &file_path)?;
    if !full_path.is_dir() {
        return Ok(json!({ "success": false, "error": "Not a manuscript package" }));
    }

    let settings_snapshot =
        with_store(state, |store| Ok(settings_store::settings_snapshot(&store)))?;
    let Some((endpoint, api_key, model_name)) = resolve_transcription_settings(&settings_snapshot)
    else {
        return Ok(json!({
            "success": false,
            "error": "未配置音频转写服务，请先在设置中填写 transcription endpoint/model。"
        }));
    };

    let mut project = ensure_editor_project(&full_path)?;
    let source_item = project
        .get("items")
        .and_then(Value::as_array)
        .and_then(|items| {
            items.iter().find(|item| {
                item.get("id")
                    .and_then(Value::as_str)
                    .map(|value| value == source_item_id)
                    .unwrap_or(false)
            })
        })
        .cloned();
    let Some(source_item) = source_item else {
        return Ok(json!({ "success": false, "error": "Source clip not found" }));
    };
    if source_item.get("type").and_then(Value::as_str) != Some("media") {
        return Ok(json!({
            "success": false,
            "error": "当前只支持对音频/视频素材片段识别字幕"
        }));
    }

    let asset_id = source_item
        .get("assetId")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let asset = project
        .get("assets")
        .and_then(Value::as_array)
        .and_then(|assets| {
            assets.iter().find(|asset| {
                asset
                    .get("id")
                    .and_then(Value::as_str)
                    .map(|value| value == asset_id)
                    .unwrap_or(false)
            })
        })
        .cloned();
    let Some(asset) = asset else {
        return Ok(json!({ "success": false, "error": "Source asset not found" }));
    };

    let asset_kind = asset.get("kind").and_then(Value::as_str).unwrap_or("video");
    if asset_kind != "audio" && asset_kind != "video" {
        return Ok(json!({
            "success": false,
            "error": "当前片段不是音频或视频素材"
        }));
    }

    let media_source = asset
        .get("src")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    if media_source.is_empty() {
        return Ok(json!({ "success": false, "error": "当前片段缺少素材路径" }));
    }
    let mime_type = asset
        .get("mimeType")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(if asset_kind == "audio" {
            "audio/*"
        } else {
            "video/*"
        });

    let from_ms = source_item
        .get("fromMs")
        .and_then(Value::as_i64)
        .unwrap_or(0)
        .max(0);
    let duration_ms = source_item
        .get("durationMs")
        .and_then(Value::as_i64)
        .unwrap_or(DEFAULT_TIMELINE_CLIP_MS)
        .max(500);
    let trim_in_ms = source_item
        .get("trimInMs")
        .and_then(Value::as_i64)
        .unwrap_or(0)
        .max(0);

    let (local_media_path, should_cleanup_media) =
        resolve_project_media_source_path(state, &full_path, &media_source)?;
    let raw_srt = crate::desktop_io::run_curl_transcription_with_response_format(
        &endpoint,
        api_key.as_deref(),
        &model_name,
        &local_media_path,
        mime_type,
        Some("srt"),
    );
    if should_cleanup_media {
        let _ = fs::remove_file(&local_media_path);
    }
    let raw_srt = raw_srt?;

    let parsed_segments = parse_srt_segments(&raw_srt);
    let source_segments = if parsed_segments.is_empty() {
        build_fallback_srt_segments(&raw_srt, duration_ms)
    } else {
        parsed_segments
    };
    if source_segments.is_empty() {
        return Ok(json!({ "success": false, "error": "转写结果为空" }));
    }

    let clip_end_ms = trim_in_ms + duration_ms;
    let clip_relative_segments = source_segments
        .into_iter()
        .filter_map(|segment| {
            let intersect_start = segment.start_ms.max(trim_in_ms);
            let intersect_end = segment.end_ms.min(clip_end_ms);
            if intersect_end <= intersect_start {
                return None;
            }
            Some(SrtSegment {
                start_ms: (intersect_start - trim_in_ms).max(0),
                end_ms: (intersect_end - trim_in_ms).max(0),
                text: segment.text.trim().to_string(),
            })
        })
        .filter(|segment| !segment.text.is_empty() && segment.end_ms > segment.start_ms)
        .collect::<Vec<_>>();

    let clip_relative_segments = if clip_relative_segments.is_empty() {
        build_fallback_srt_segments(&raw_srt, duration_ms)
    } else {
        clip_relative_segments
    };
    if clip_relative_segments.is_empty() {
        return Ok(json!({ "success": false, "error": "没有可写入时间轴的字幕片段" }));
    }

    let target_track_id = payload_string(payload, "track")
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .or_else(|| {
            project
                .get("tracks")
                .and_then(Value::as_array)
                .and_then(|tracks| {
                    tracks.iter().find_map(|track| {
                        let kind = track.get("kind").and_then(Value::as_str).unwrap_or("");
                        let id = track.get("id").and_then(Value::as_str).unwrap_or("");
                        if kind == "subtitle" && !id.trim().is_empty() {
                            Some(id.to_string())
                        } else {
                            None
                        }
                    })
                })
        })
        .unwrap_or_else(|| "S1".to_string());
    ensure_editor_track(&mut project, &target_track_id, "subtitle")?;

    let subtitle_dir = full_path.join("subtitles");
    fs::create_dir_all(&subtitle_dir).map_err(|error| error.to_string())?;
    let subtitle_file_name = format!(
        "{}.srt",
        source_item_id
            .chars()
            .map(|ch| match ch {
                'a'..='z' | 'A'..='Z' | '0'..='9' | '-' | '_' => ch,
                _ => '-',
            })
            .collect::<String>()
    );
    let subtitle_relative_path = format!("subtitles/{subtitle_file_name}");
    let subtitle_file_path = subtitle_dir.join(&subtitle_file_name);
    write_text_file(
        &subtitle_file_path,
        &serialize_srt_segments(&clip_relative_segments),
    )?;

    let style_template = editor_default_subtitle_style(
        &source_item_id,
        &subtitle_relative_path,
        payload_field(payload, "subtitleStyle"),
    );
    let inserted_items = clip_relative_segments
        .iter()
        .enumerate()
        .map(|(index, segment)| {
            let mut style = style_template.clone();
            if let Some(style_object) = style.as_object_mut() {
                style_object.insert("segmentIndex".to_string(), json!(index));
                style_object.insert("startMs".to_string(), json!(segment.start_ms));
                style_object.insert("endMs".to_string(), json!(segment.end_ms));
            }
            json!({
                "id": make_id("subtitle-item"),
                "type": "subtitle",
                "trackId": target_track_id,
                "text": segment.text,
                "fromMs": from_ms + segment.start_ms,
                "durationMs": (segment.end_ms - segment.start_ms).max(240),
                "style": style,
                "enabled": true
            })
        })
        .collect::<Vec<_>>();
    let first_inserted_item_id = inserted_items
        .first()
        .and_then(|item| item.get("id").and_then(Value::as_str))
        .map(ToString::to_string);
    {
        let items = editor_project_items_mut(&mut project)?;
        items.retain(|item| {
            if item.get("type").and_then(Value::as_str) != Some("subtitle") {
                return true;
            }
            item.get("style")
                .and_then(Value::as_object)
                .and_then(|style| style.get("sourceItemId"))
                .and_then(Value::as_str)
                .map(|value| value != source_item_id)
                .unwrap_or(true)
        });
        items.extend(inserted_items);
    }
    upsert_editor_project_last_subtitle_transcription(
        &mut project,
        &source_item_id,
        &subtitle_relative_path,
        clip_relative_segments.len(),
    )?;
    normalize_editor_project_timeline(&mut project)?;
    write_json_value(&package_editor_project_path(&full_path), &project)?;
    Ok(json!({
        "success": true,
        "clipId": source_item_id,
        "subtitleCount": clip_relative_segments.len(),
        "subtitleFile": subtitle_relative_path,
        "insertedClipId": first_inserted_item_id,
        "state": get_manuscript_package_state(&full_path)?
    }))
}
